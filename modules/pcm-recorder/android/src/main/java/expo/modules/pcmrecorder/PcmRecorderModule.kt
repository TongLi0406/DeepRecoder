package expo.modules.pcmrecorder

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.RandomAccessFile
import java.net.Inet4Address
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import okhttp3.Dns
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody

class PcmRecorderModule : Module() {

  companion object {
    private const val DEFAULT_SPEAKER_MODEL = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"
    private const val DEFAULT_VAD_MODEL = "silero_vad.onnx"
    private const val MAX_SPEAKER_WAV_BYTES = 64L * 1024L * 1024L

    private val AUDIO_SOURCES = intArrayOf(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      MediaRecorder.AudioSource.MIC,
      MediaRecorder.AudioSource.DEFAULT
    )

    private val ordinaryActive = AtomicBoolean(false)

    fun ordinaryRecordingActive(): Boolean = ordinaryActive.get()

    fun resolveDiaryModelPaths(filesDir: File): DiaryModelPaths {
      val modelDir = DiaryPaths.modelRoot(filesDir)
      val speaker = File(modelDir, DEFAULT_SPEAKER_MODEL)
      val vad = File(modelDir, DEFAULT_VAD_MODEL)
      return DiaryModelPaths(
        speakerModelPath = speaker.absolutePath,
        vadModelPath = vad.absolutePath,
        ready = speaker.exists() && vad.exists(),
      )
    }
  }

  private var audioRecord: AudioRecord? = null
  private var recordingThread: Thread? = null
  private val isRecordingFlag = AtomicBoolean(false)
  private val isPausedFlag = AtomicBoolean(false)
  private val pauseLock = Object()
  private val startTimeMs = AtomicLong(0)
  private val capturedSamples = AtomicLong(0)
  private var currentFilePath: String? = null
  private var currentWavFile: File? = null
  private var currentSampleRate: Int = 16000

  override fun definition() = ModuleDefinition {

    Name("PcmRecorder")

    Events("onRecordingProgress", "onRecordingStopped", "onRecordingError")

    OnDestroy { forceCleanup() }

    Function("hasPermission") {
      val context = appContext.reactContext
        ?: throw CodedException("React context not available")
      val granted = ContextCompat.checkSelfPermission(
        context, Manifest.permission.RECORD_AUDIO
      ) == PackageManager.PERMISSION_GRANTED
      granted
    }

    Function("getStatus") {
      val status = mapOf(
        "isRecording" to isRecordingFlag.get(),
        "isPaused" to isPausedFlag.get(),
        "filePath" to currentFilePath,
        "durationMs" to ((capturedSamples.get() * 1000L) / currentSampleRate.toLong()),
        "fileSizeBytes" to (currentFilePath?.let { File(it).let { if (it.exists()) it.length() else 0L } } ?: 0L)
      )
      status
    }

    AsyncFunction("startRecording") { options: RecordingOptions ->
      if (isRecordingFlag.get()) {
        throw CodedException("Already recording")
      }

      val context = appContext.reactContext
        ?: throw CodedException("React context not available")

      val manifest = DiaryManifestStore.load(context.filesDir)
      if (manifest.active || DiaryForegroundService.serviceActive) {
        throw CodedException("Diary capture is active")
      }

      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
          != PackageManager.PERMISSION_GRANTED) {
        throw CodedException("RECORD_AUDIO permission not granted")
      }

      currentSampleRate = options.sampleRate ?: 16000

      val fileName = options.fileName ?: "pcm_${System.currentTimeMillis()}.wav"
        val outputDir = File(context.filesDir, "pcm-recordings")
        outputDir.mkdirs()
        val outputFile = File(outputDir, fileName)
      if (outputFile.exists()) outputFile.delete()

      val bufferSize = AudioRecord.getMinBufferSize(
        currentSampleRate,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT
      )
      if (bufferSize <= 0) {
        throw CodedException("Invalid buffer size for sample rate $currentSampleRate")
      }

      val actualBufferSize = maxOf(bufferSize * 4, 4096)
      audioRecord = createAudioRecord(currentSampleRate, actualBufferSize)
        ?: throw CodedException("Failed to initialize AudioRecord")

      WavIo.writePlaceholderHeader(outputFile, currentSampleRate)

      audioRecord!!.startRecording()
      isRecordingFlag.set(true)
      ordinaryActive.set(true)
      isPausedFlag.set(false)
      startTimeMs.set(System.currentTimeMillis())
      capturedSamples.set(0)
      currentFilePath = outputFile.absolutePath
      currentWavFile = outputFile

      recordingThread = Thread({
        writeWavFile(outputFile, actualBufferSize)
      }, "PcmRecorder").apply {
        priority = Thread.MAX_PRIORITY
        start()
      }

      mapOf(
        "isRecording" to true,
        "filePath" to outputFile.absolutePath
      )
    }

    AsyncFunction("stopRecording") {
      if (!isRecordingFlag.get()) {
        throw CodedException("Not recording")
      }

      isRecordingFlag.set(false)
      try { audioRecord?.stop() } catch (_: Exception) {}

      recordingThread?.let { thread ->
        try { thread.join(10_000) } catch (_: InterruptedException) {}
      }
      recordingThread = null

      audioRecord?.release()
      audioRecord = null
      ordinaryActive.set(false)
      isPausedFlag.set(false)

      currentWavFile?.let { WavIo.finalizeHeader(it, currentSampleRate) }

      val filePath = currentFilePath
      val durationMs = (capturedSamples.get() * 1000L) / currentSampleRate.toLong()
      val fileSize = filePath?.let { File(it).let { f -> if (f.exists()) f.length() else 0L } } ?: 0L

      sendEvent("onRecordingStopped", mapOf(
        "filePath" to filePath,
        "durationMs" to durationMs,
        "fileSizeBytes" to fileSize
      ))

      mapOf(
        "isRecording" to false,
        "isPaused" to false,
        "filePath" to filePath,
        "durationMs" to durationMs,
        "fileSizeBytes" to fileSize
      )
    }

    AsyncFunction("pauseRecording") {
      if (!isRecordingFlag.get()) {
        throw CodedException("Not recording")
      }
      isPausedFlag.set(true)
      mapOf(
        "isRecording" to true,
        "isPaused" to true,
        "filePath" to currentFilePath,
        "durationMs" to (capturedSamples.get() * 1000L) / currentSampleRate.toLong(),
        "fileSizeBytes" to (currentFilePath?.let { path -> File(path).let { if (it.exists()) it.length() else 0L } } ?: 0L)
      )
    }

    AsyncFunction("resumeRecording") {
      if (!isRecordingFlag.get()) {
        throw CodedException("Not recording")
      }
      isPausedFlag.set(false)
      synchronized(pauseLock) {
        pauseLock.notifyAll()
      }
      mapOf(
        "isRecording" to true,
        "isPaused" to false,
        "filePath" to currentFilePath,
        "durationMs" to (capturedSamples.get() * 1000L) / currentSampleRate.toLong(),
        "fileSizeBytes" to (currentFilePath?.let { path -> File(path).let { if (it.exists()) it.length() else 0L } } ?: 0L)
      )
    }

    AsyncFunction("cancelRecording") {
      isRecordingFlag.set(false)
      isPausedFlag.set(false)
      ordinaryActive.set(false)
      synchronized(pauseLock) {
        pauseLock.notifyAll()
      }

      try { audioRecord?.stop() } catch (_: Exception) {}
      recordingThread?.let { thread ->
        try { thread.join(5_000) } catch (_: InterruptedException) {}
      }
      recordingThread = null

      audioRecord?.release()
      audioRecord = null

      currentFilePath?.let { File(it).delete() }
      currentFilePath = null
      currentWavFile = null
      capturedSamples.set(0)
      true
    }

    AsyncFunction("deleteRecording") { filePath: String ->
      File(filePath).let { if (it.exists()) it.delete() else false }
    }

    AsyncFunction("getDiaryStatus") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      var manifest = DiaryManifestStore.load(context.filesDir)
      // 进程被杀/重装后 manifest 可能仍是 active，但服务已不存在，需要自愈
      if (!DiaryForegroundService.serviceActive && manifest.active) {
        manifest = DiaryManifestStore.recover(context.filesDir)
      }
      val modelPaths = resolveDiaryModelPaths(context.filesDir)
      mapOf(
        "active" to (manifest.active || DiaryForegroundService.serviceActive),
        "paused" to manifest.paused,
        "error" to manifest.error,
        "hasSpeakerProfile" to SherpaSpeaker.hasProfile(context),
        "modelsReady" to modelPaths.ready,
      )
    }

    AsyncFunction("prepareDiaryModels") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      DiaryPaths.ensureAll(context.filesDir)

      val modelDir = DiaryPaths.modelRoot(context.filesDir)
      copyAssetIfExists(context, "sherpa/$DEFAULT_VAD_MODEL", File(modelDir, DEFAULT_VAD_MODEL))
      copyAssetIfExists(context, "sherpa/$DEFAULT_SPEAKER_MODEL", File(modelDir, DEFAULT_SPEAKER_MODEL))

      val modelPaths = resolveDiaryModelPaths(context.filesDir)
      if (!modelPaths.ready) {
        throw CodedException("models_not_ready: missing $DEFAULT_VAD_MODEL or $DEFAULT_SPEAKER_MODEL")
      }

      try {
        SherpaVad(modelPaths.vadModelPath).release()
      } catch (e: Throwable) {
        throw CodedException("vad_model_invalid_or_aar_missing", e)
      }

      true
    }

    AsyncFunction("startDiary") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      if (isRecordingFlag.get()) {
        throw CodedException("Ordinary PCM recording is active")
      }
      if (DiaryForegroundService.serviceActive) {
        return@AsyncFunction true
      }
      val manifest = DiaryManifestStore.load(context.filesDir)
      if (manifest.active) {
        DiaryManifestStore.recover(context.filesDir)
      }
      val modelPaths = resolveDiaryModelPaths(context.filesDir)
      if (!modelPaths.ready) {
        throw CodedException("models_not_ready")
      }
      DiaryForegroundService.start(context)
      true
    }

    AsyncFunction("stopDiary") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      DiaryForegroundService.stop(context)
      true
    }

    AsyncFunction("pauseDiary") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      DiaryForegroundService.pause(context)
      true
    }

    AsyncFunction("resumeDiary") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      DiaryForegroundService.resume(context)
      true
    }

    AsyncFunction("listDiarySegments") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      // 采集进行中不能调用 recover()，否则会清空 active/current 并提前写入 WAV 头
      val segments = if (DiaryForegroundService.serviceActive) {
        DiaryManifestStore.load(context.filesDir).segments
      } else {
        DiaryManifestStore.recover(context.filesDir).segments
      }
      segments.map {
        mapOf(
          "id" to it.id,
          "filePath" to it.filePath,
          "startTime" to it.startTime,
          "endTime" to it.endTime,
          "localDate" to it.localDate,
          "utcOffsetMinutes" to it.utcOffsetMinutes,
          "durationMs" to it.durationMs,
        )
      }
    }

    AsyncFunction("deleteDiarySegment") { id: String ->
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      val manifest = DiaryManifestStore.load(context.filesDir)
      if (manifest.active && manifest.current?.id == id) {
        throw CodedException("segment_active")
      }
      val seg = manifest.segments.firstOrNull { it.id == id }
      DiaryManifestStore.deleteSegment(context.filesDir, id)
      seg?.let { File(it.filePath).delete() }
      true
    }

    AsyncFunction("identifySpeaker") { filePath: String ->
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      val modelPaths = resolveDiaryModelPaths(context.filesDir)
      if (!modelPaths.ready) {
        throw CodedException("models_not_ready")
      }
      val wavFile = resolveTrustedWavFile(context, filePath)
      val result = SherpaSpeaker.identify(context, modelPaths.speakerModelPath, wavFile.absolutePath)
      speakerEvidenceToMap(result)
    }

    AsyncFunction("enrollSpeaker") { filePath: String ->
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      val modelPaths = resolveDiaryModelPaths(context.filesDir)
      if (!modelPaths.ready) {
        throw CodedException("models_not_ready")
      }
      val wavFile = resolveTrustedWavFile(context, filePath)
      SherpaSpeaker.enroll(context, modelPaths.speakerModelPath, wavFile.absolutePath)
      true
    }

    AsyncFunction("deleteSpeakerProfile") {
      val context = appContext.reactContext ?: throw CodedException("React context not available")
      SherpaSpeaker.deleteProfile(context)
      true
    }

    // ─── HTTP (IPv4 优先，规避不可达的 IPv6 地址导致请求挂死) ───
    AsyncFunction("httpPostJson") { url: String, headers: Map<String, String>, body: String, timeoutMs: Int ->
      val builder = Request.Builder()
        .url(url)
        .post(body.toRequestBody("application/json".toMediaType()))
      headers.forEach { (key, value) -> builder.header(key, value) }
      executeHttp(builder.build(), timeoutMs)
    }

    AsyncFunction("httpPostMultipart") { url: String, headers: Map<String, String>, fields: Map<String, String>, filePath: String, fileName: String, mimeType: String, timeoutMs: Int ->
      val file = File(filePath.removePrefix("file://"))
      if (!file.exists()) throw CodedException("audio_file_not_found")
      val multipart = MultipartBody.Builder().setType(MultipartBody.FORM)
      fields.forEach { (key, value) -> multipart.addFormDataPart(key, value) }
      multipart.addFormDataPart("file", fileName, file.asRequestBody(mimeType.toMediaTypeOrNull()))
      val builder = Request.Builder()
        .url(url)
        .post(multipart.build())
      headers.forEach { (key, value) -> builder.header(key, value) }
      executeHttp(builder.build(), timeoutMs)
    }
  }

  private fun executeHttp(request: Request, timeoutMs: Int): Map<String, Any> {
    val client = OkHttpClient.Builder()
      .dns(ipv4FirstDns)
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      .writeTimeout(timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      .build()
    client.newCall(request).execute().use { response ->
      return mapOf(
        "status" to response.code,
        "body" to (response.body?.string() ?: ""),
      )
    }
  }

  private val ipv4FirstDns: Dns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
      val addresses = Dns.SYSTEM.lookup(hostname)
      val ipv4 = addresses.filterIsInstance<Inet4Address>()
      return if (ipv4.isNotEmpty()) ipv4 else addresses
    }
  }

  private fun createAudioRecord(sampleRate: Int, bufferSize: Int): AudioRecord? {
    for (source in AUDIO_SOURCES) {
      try {
        val recorder = AudioRecord(source, sampleRate,
          AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)
        if (recorder.state == AudioRecord.STATE_INITIALIZED) return recorder
        recorder.release()
      } catch (_: Exception) {}
    }
    return null
  }

  private fun writeWavFile(outputFile: File, bufferSize: Int) {
    RandomAccessFile(outputFile, "rw").use { raf ->
      try {
        raf.seek(44)
        val shorts = ShortArray(bufferSize / 2)

        while (isRecordingFlag.get()) {
          if (isPausedFlag.get()) {
            synchronized(pauseLock) {
              while (isPausedFlag.get() && isRecordingFlag.get()) {
                pauseLock.wait()
              }
            }
            if (!isRecordingFlag.get()) {
              break
            }
          }

          val samplesRead = audioRecord?.read(shorts, 0, shorts.size) ?: -1
          if (samplesRead == 0) {
            continue
          }
          if (samplesRead < 0) {
            if (samplesRead != AudioRecord.ERROR_DEAD_OBJECT) {
              sendEvent("onRecordingError", mapOf("error" to "audio_read_error_$samplesRead"))
              break
            }
            continue
          }

          val bytes = ByteArray(samplesRead * 2)
          var i = 0
          while (i < samplesRead) {
            val value = shorts[i].toInt()
            bytes[i * 2] = (value and 0xFF).toByte()
            bytes[i * 2 + 1] = ((value ushr 8) and 0xFF).toByte()
            i += 1
          }
          raf.write(bytes)
          capturedSamples.addAndGet(samplesRead.toLong())
        }
        raf.fd.sync()
      } catch (_: Exception) {
      }
    }
    WavIo.finalizeHeader(outputFile, currentSampleRate)
  }

  private fun forceCleanup() {
    isRecordingFlag.set(false)
    isPausedFlag.set(false)
    ordinaryActive.set(false)
    synchronized(pauseLock) {
      pauseLock.notifyAll()
    }
    recordingThread?.let { try { it.join(3_000); if (it.isAlive) it.interrupt() } catch (_: Exception) {} }
    recordingThread = null
    try { audioRecord?.stop() } catch (_: Exception) {}
    audioRecord?.release()
    audioRecord = null
    currentWavFile?.let { WavIo.finalizeHeader(it, currentSampleRate) }

    val context = appContext.reactContext
    if (context != null) {
      DiaryForegroundService.recoverManifest(context.filesDir)
    }
  }

  private fun copyAssetIfExists(context: android.content.Context, assetPath: String, outFile: File) {
    try {
      context.assets.open(assetPath).use { input ->
        outFile.parentFile?.mkdirs()
        outFile.outputStream().use { output -> input.copyTo(output) }
      }
    } catch (_: Exception) {
    }
  }

  private fun resolveTrustedWavFile(context: android.content.Context, path: String): File {
    val file = try {
      File(path).canonicalFile
    } catch (e: Exception) {
      throw CodedException("invalid_audio_path", e)
    }
    if (!file.exists() || !file.isFile) {
      throw CodedException("audio_file_not_found")
    }
    if (file.length() <= 0L || file.length() > MAX_SPEAKER_WAV_BYTES) {
      throw CodedException("audio_file_size_invalid")
    }

    val roots = listOfNotNull(
      context.filesDir?.canonicalFile,
      context.noBackupFilesDir?.canonicalFile,
      context.cacheDir?.canonicalFile,
      context.getExternalFilesDir(null)?.canonicalFile,
    )
    val trusted = roots.any { root ->
      file.path == root.path || file.path.startsWith(root.path + File.separator)
    }
    if (!trusted) {
      throw CodedException("audio_path_not_trusted")
    }
    return file
  }
}

data class DiaryModelPaths(
  val speakerModelPath: String,
  val vadModelPath: String,
  val ready: Boolean,
)
