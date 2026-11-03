package expo.modules.pcmrecorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.os.StatFs
import androidx.core.app.NotificationCompat
import java.io.File
import java.io.RandomAccessFile
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

class DiaryForegroundService : Service() {
  companion object {
    private const val CHANNEL_ID = "pcm_diary_capture"
    private const val NOTIFICATION_ID = 98342
    private const val ACTION_START = "expo.modules.pcmrecorder.action.START_DIARY"
    private const val ACTION_STOP = "expo.modules.pcmrecorder.action.STOP_DIARY"
    private const val ACTION_PAUSE = "expo.modules.pcmrecorder.action.PAUSE_DIARY"
    private const val ACTION_RESUME = "expo.modules.pcmrecorder.action.RESUME_DIARY"

    private const val DISK_FLOOR_BYTES = 500L * 1024L * 1024L
    private const val DIARY_CAP_BYTES = 500L * 1024L * 1024L
    private const val LOW_BATTERY_PERCENT = 15

    private const val PREBUFFER_MS = 500
    private const val TAIL_MS = 400
    private const val MAX_SEGMENT_MS = 5 * 60 * 1000
    private const val SAFETY_CHECK_INTERVAL_MS = 30_000L

    @Volatile
    var serviceActive: Boolean = false

    fun start(context: Context) {
      val intent = Intent(context, DiaryForegroundService::class.java).setAction(ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      val intent = Intent(context, DiaryForegroundService::class.java).setAction(ACTION_STOP)
      context.stopService(intent)
    }

    fun pause(context: Context) {
      context.startService(Intent(context, DiaryForegroundService::class.java).setAction(ACTION_PAUSE))
    }

    fun resume(context: Context) {
      context.startService(Intent(context, DiaryForegroundService::class.java).setAction(ACTION_RESUME))
    }

    fun recoverManifest(filesDir: File) {
      DiaryPaths.ensureAll(filesDir)
      DiaryManifestStore.recover(filesDir)
    }
  }

  private var record: AudioRecord? = null
  private var worker: Thread? = null
  private val running = AtomicBoolean(false)
  private val paused = AtomicBoolean(false)
  private val stopping = AtomicBoolean(false)
  private val finalizeLock = Any()
  private val pauseLock = Object()
  private val captureStateLock = Object()
  private var finalized = false
  private var stopReason: String? = null

  private var currentOut: RandomAccessFile? = null
  private var currentSegment: DiaryCurrentSegment? = null
  private var currentPcmBytes: Long = 0
  private var currentSamples: Long = 0
  private var speechActive = false
  private var silenceSamples = 0
  private var lastProb = 0f
  private val prebuffer = ArrayDeque<Short>()
  private var captureBaseInstant: Instant? = null
  private var captureZoneId: ZoneId = ZoneId.systemDefault()
  private var diaryBytesEstimate: Long = 0L
  private var lastSafetyCheckMs: Long = 0L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    createChannel()
    serviceActive = true
  }

  override fun onDestroy() {
    stopCaptureInternal("service_destroy")
    serviceActive = false
    super.onDestroy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        stopCaptureInternal(null)
        stopSelf()
      }
      ACTION_PAUSE -> {
        paused.set(true)
        synchronized(captureStateLock) {
          if (speechActive) {
            endSegmentLocked()
            speechActive = false
            silenceSamples = 0
          }
          prebuffer.clear()
        }
        DiaryManifestStore.upsertCurrent(filesDir, currentSegment, active = running.get(), paused = true, error = null)
      }
      ACTION_RESUME -> {
        paused.set(false)
        prebuffer.clear()
        synchronized(pauseLock) {
          pauseLock.notifyAll()
        }
        DiaryManifestStore.upsertCurrent(filesDir, currentSegment, active = running.get(), paused = false, error = null)
      }
      ACTION_START -> {
        if (!running.get()) {
          startForeground(NOTIFICATION_ID, buildNotification("Recording diary"))
          startCaptureInternal()
        }
      }
      else -> {
        stopSelf()
      }
    }
    return START_NOT_STICKY
  }

  private fun startCaptureInternal() {
    if (PcmRecorderModule.ordinaryRecordingActive()) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "ordinary_recording_active")
      stopSelf()
      return
    }

    val models = PcmRecorderModule.resolveDiaryModelPaths(filesDir)
    if (!models.ready) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "models_not_ready")
      stopSelf()
      return
    }

    DiaryManifestStore.upsertCurrent(filesDir, null, active = true, paused = false, error = null)

    val minBuffer = AudioRecord.getMinBufferSize(
      DiaryPaths.SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
    )
    if (minBuffer <= 0) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "audio_record_init_failed")
      stopSelf()
      return
    }

    val bufferSize = maxOf(minBuffer * 2, 4096)
    record = AudioRecord(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      DiaryPaths.SAMPLE_RATE,
      AudioFormat.CHANNEL_IN_MONO,
      AudioFormat.ENCODING_PCM_16BIT,
      bufferSize,
    )
    if (record?.state != AudioRecord.STATE_INITIALIZED) {
      record?.release()
      record = null
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "audio_record_not_initialized")
      stopSelf()
      return
    }

    running.set(true)
    paused.set(false)
    finalized = false
    stopReason = null
    currentPcmBytes = 0
    currentSamples = 0
    speechActive = false
    silenceSamples = 0
    captureBaseInstant = Instant.now()
    captureZoneId = ZoneId.systemDefault()
    prebuffer.clear()
    diaryBytesEstimate = DiaryManifestStore.load(filesDir).segments.sumOf { seg -> File(seg.filePath).takeIf { it.exists() }?.length() ?: 0L }
    lastSafetyCheckMs = 0L

    worker = Thread({
      captureLoop(models.vadModelPath)
    }, "DiaryForegroundCapture").apply {
      start()
    }
  }

  private fun captureLoop(vadModelPath: String) {
    val chunkSamples = 512
    val shorts = ShortArray(chunkSamples)
    val vad = try {
      SherpaVad(vadModelPath)
    } catch (_: Throwable) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "vad_init_failed")
      running.set(false)
      stopSelf()
      return
    }

    try {
      record?.startRecording()
      var chunks = 0L
      while (running.get()) {
        waitIfPausedOrStopped()
        if (!running.get()) break

        if (!isCaptureSafeDecimated()) {
          requestStop("capture_safety_stop")
          stopSelf()
          break
        }

        val n = record?.read(shorts, 0, shorts.size) ?: -1
        if (n == 0) {
          continue
        }
        if (n < 0) {
          if (!isTransientReadError(n)) {
            requestStop("audio_read_error_$n")
            break
          }
          continue
        }
        val chunkStartSample = currentSamples
        currentSamples += n.toLong()
        chunks += 1

        val chunk = if (n == shorts.size) shorts else shorts.copyOf(n)
        pushPrebuffer(chunk)

        val score = vad.computeScore(WavIo.shortsToFloats(chunk, chunk.size))
        lastProb = score
        val isSpeech = score >= 0.55f

        if (isSpeech && !speechActive) {
          val prebufferCount = prebuffer.size
          val prebufferWithoutCurrent = (prebufferCount - chunk.size).coerceAtLeast(0)
          beginSegment((chunkStartSample - prebufferWithoutCurrent.toLong()).coerceAtLeast(0L))
          speechActive = true
          silenceSamples = 0
          writePrebufferToCurrent(prebufferWithoutCurrent)
        }

        if (speechActive) {
          writeChunkWithMidnightSplit(chunk, chunkStartSample)
          if (isSpeech) {
            silenceSamples = 0
          } else {
            silenceSamples += n
            val tailSamples = (DiaryPaths.SAMPLE_RATE * TAIL_MS) / 1000
            if (silenceSamples >= tailSamples) {
              synchronized(captureStateLock) {
                endSegmentLocked()
              }
              speechActive = false
              silenceSamples = 0
              prebuffer.clear()
            }
          }

          val maxSamples = (DiaryPaths.SAMPLE_RATE.toLong() * MAX_SEGMENT_MS.toLong()) / 1000L
          if (currentPcmBytes / 2 >= maxSamples) {
            synchronized(captureStateLock) {
              endSegmentLocked()
            }
            speechActive = false
            silenceSamples = 0
            prebuffer.clear()
          }
        }

        if (chunks % 250L == 0L) {
          DiaryManifestStore.upsertCurrent(filesDir, currentSegment, active = true, paused = paused.get(), error = null)
        }
      }
    } catch (_: Throwable) {
      requestStop("capture_runtime_error")
    } finally {
      vad.release()
      finalizeCaptureOnce()
    }
  }

  private fun stopCaptureInternal(error: String?) {
    if (!stopping.compareAndSet(false, true)) {
      return
    }
    requestStop(error)

    try {
      record?.stop()
    } catch (_: Throwable) {
    }
    record?.release()
    record = null

    synchronized(pauseLock) {
      pauseLock.notifyAll()
    }

    val localWorker = worker
    if (localWorker != null && localWorker !== Thread.currentThread()) {
      try {
        localWorker.join(1500)
      } catch (_: InterruptedException) {
      }
    }
    finalizeCaptureOnce()
    stopping.set(false)
  }

  private fun requestStop(error: String?) {
    running.set(false)
    if (error != null && stopReason == null) {
      stopReason = error
    }
  }

  private fun finalizeCaptureOnce() {
    synchronized(finalizeLock) {
      if (finalized) return
      finalized = true
    }

    synchronized(captureStateLock) {
      if (currentSegment != null) {
        endSegmentLocked()
      }
    }

    worker = null
    DiaryManifestStore.clearCurrentAndDeactivate(filesDir, stopReason)
    stopForeground(STOP_FOREGROUND_REMOVE)
  }

  private fun beginSegment(startSample: Long) {
    val now = sampleToOffset(startSample)
    val outFile = DiaryPaths.newSegmentFile(filesDir)
    WavIo.writePlaceholderHeader(outFile, DiaryPaths.SAMPLE_RATE)
    currentOut = RandomAccessFile(outFile, "rw").also { it.seek(44) }
    currentPcmBytes = 0
    currentSegment = DiaryCurrentSegment(
      id = outFile.nameWithoutExtension.removePrefix("seg_"),
      filePath = outFile.canonicalPath,
      startTime = now.toInstant().toString(),
      localDate = now.toLocalDate().toString(),
      utcOffsetMinutes = now.offset.totalSeconds / 60,
      startSample = startSample,
    )
    DiaryManifestStore.upsertCurrent(filesDir, currentSegment, active = true, paused = false, error = null)
  }

  private fun writePrebufferToCurrent(sampleCount: Int) {
    if (currentOut == null || sampleCount <= 0 || prebuffer.isEmpty()) return
    val size = sampleCount.coerceAtMost(prebuffer.size)
    val arr = ShortArray(size)
    var idx = 0
    val skip = prebuffer.size - size
    for (s in prebuffer.take(skip + size).drop(skip)) {
      arr[idx] = s
      idx += 1
    }
    writeChunkToCurrent(arr)
  }

  private fun writeChunkToCurrent(chunk: ShortArray) {
    val out = currentOut ?: return
    val bytes = ByteArray(chunk.size * 2)
    var i = 0
    while (i < chunk.size) {
      val v = chunk[i].toInt()
      bytes[i * 2] = (v and 0xFF).toByte()
      bytes[i * 2 + 1] = ((v ushr 8) and 0xFF).toByte()
      i += 1
    }
    out.write(bytes)
    currentPcmBytes += bytes.size
  }

  private fun endSegmentLocked() {
    val segment = currentSegment ?: return
    val out = currentOut
    currentOut = null
    currentSegment = null

    try {
      out?.close()
    } catch (_: Throwable) {
    }

    val file = File(segment.filePath)
    WavIo.finalizeHeader(file, DiaryPaths.SAMPLE_RATE)

    val end = sampleToOffset(segment.startSample + (currentPcmBytes / 2L))
    val durationMs = ((currentPcmBytes / 2L) * 1000L) / DiaryPaths.SAMPLE_RATE.toLong()
    val finalSegment = DiarySegment(
      id = segment.id,
      filePath = segment.filePath,
      startTime = segment.startTime,
      endTime = end.toInstant().toString(),
      localDate = segment.localDate,
      utcOffsetMinutes = segment.utcOffsetMinutes,
      durationMs = durationMs,
    )
    DiaryManifestStore.appendSegment(filesDir, finalSegment)
    diaryBytesEstimate += file.length().coerceAtLeast(0L)
    currentPcmBytes = 0
  }

  private fun createChannel() {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Diary Recording",
        NotificationManager.IMPORTANCE_LOW,
      )
      manager.createNotificationChannel(channel)
    }
  }

  private fun buildNotification(text: String): Notification {
    val stopIntent = Intent(this, DiaryForegroundService::class.java).setAction(ACTION_STOP)
    val stopPending = PendingIntent.getService(
      this,
      1,
      stopIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Diary capture active")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setOngoing(true)
      .addAction(0, "STOP", stopPending)
      .build()
  }

  private fun pushPrebuffer(chunk: ShortArray) {
    val maxSamples = (DiaryPaths.SAMPLE_RATE * PREBUFFER_MS) / 1000
    for (s in chunk) {
      prebuffer.addLast(s)
      while (prebuffer.size > maxSamples) {
        prebuffer.removeFirst()
      }
    }
  }

  private fun isCaptureSafeDecimated(): Boolean {
    val now = SystemClock.elapsedRealtime()
    if (lastSafetyCheckMs != 0L && now - lastSafetyCheckMs < SAFETY_CHECK_INTERVAL_MS) {
      return true
    }
    lastSafetyCheckMs = now

    val stat = StatFs(filesDir.absolutePath)
    if (stat.availableBytes < DISK_FLOOR_BYTES) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "disk_below_500mb")
      return false
    }

    if (diaryBytesEstimate > DIARY_CAP_BYTES) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "diary_cap_exceeded")
      return false
    }

    val battery = batteryStatus()
    if (battery.first >= 0 && battery.first <= LOW_BATTERY_PERCENT && !battery.second) {
      DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "battery_below_15")
      return false
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val pm = getSystemService(PowerManager::class.java)
      if (pm.currentThermalStatus >= PowerManager.THERMAL_STATUS_SEVERE) {
        DiaryManifestStore.clearCurrentAndDeactivate(filesDir, "thermal_severe")
        return false
      }
    }

    return true
  }

  private fun batteryStatus(): Pair<Int, Boolean> {
    val intent = registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      ?: return -1 to false
    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
    val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
      status == BatteryManager.BATTERY_STATUS_FULL
    val percent = if (level >= 0 && scale > 0) (level * 100) / scale else -1
    return percent to charging
  }

  private fun waitIfPausedOrStopped() {
    if (!paused.get()) return
    synchronized(pauseLock) {
      while (paused.get() && running.get()) {
        pauseLock.wait()
      }
    }
  }

  private fun isTransientReadError(code: Int): Boolean {
    return code == AudioRecord.ERROR_DEAD_OBJECT
  }

  private fun writeChunkWithMidnightSplit(chunk: ShortArray, chunkStartSample: Long) {
    synchronized(captureStateLock) {
      var writeOffset = 0
      var chunkOffsetStartSample = chunkStartSample

      while (writeOffset < chunk.size) {
        val seg = currentSegment ?: return
        val splitOffset = firstDateBoundaryOffset(seg.localDate, chunk, writeOffset, chunkOffsetStartSample)
        if (splitOffset == null) {
          if (writeOffset == 0) {
            writeChunkToCurrent(chunk)
          } else {
            writeChunkToCurrent(chunk.copyOfRange(writeOffset, chunk.size))
          }
          return
        }

        if (splitOffset > writeOffset) {
          writeChunkToCurrent(chunk.copyOfRange(writeOffset, splitOffset))
        }

        endSegmentLocked()
        beginSegment(chunkOffsetStartSample + (splitOffset - writeOffset).toLong())
        writeOffset = splitOffset
        chunkOffsetStartSample = chunkStartSample + writeOffset.toLong()
      }
    }
  }

  private fun firstDateBoundaryOffset(
    segmentDate: String,
    chunk: ShortArray,
    offset: Int,
    chunkOffsetStartSample: Long,
  ): Int? {
    var i = offset
    while (i < chunk.size) {
      val date = sampleToOffset(chunkOffsetStartSample + (i - offset).toLong()).toLocalDate().toString()
      if (date != segmentDate) return i
      i += 1
    }
    return null
  }

  private fun sampleToOffset(sampleIndex: Long): OffsetDateTime {
    val base = captureBaseInstant ?: Instant.now()
    val millis = (sampleIndex * 1000L) / DiaryPaths.SAMPLE_RATE.toLong()
    return base.plusMillis(millis).atZone(captureZoneId).toOffsetDateTime()
  }
}