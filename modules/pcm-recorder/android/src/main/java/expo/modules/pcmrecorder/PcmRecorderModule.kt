package expo.modules.pcmrecorder

import android.Manifest
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.log10
import kotlin.math.sqrt

class PcmRecorderModule : Module() {

  companion object {
    private const val TAG = "PcmRecorder"
    private const val BITS_PER_SAMPLE: Short = 16
    private const val NUM_CHANNELS: Short = 1

    private val AUDIO_SOURCES = intArrayOf(
      MediaRecorder.AudioSource.VOICE_RECOGNITION,
      MediaRecorder.AudioSource.MIC,
      MediaRecorder.AudioSource.DEFAULT
    )
  }

  private var audioRecord: AudioRecord? = null
  private var recordingThread: Thread? = null
  private val isRecordingFlag = AtomicBoolean(false)
  private val startTimeMs = AtomicLong(0)
  private var currentFilePath: String? = null
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
        "filePath" to currentFilePath,
        "durationMs" to if (isRecordingFlag.get()) System.currentTimeMillis() - startTimeMs.get() else 0L,
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

      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
          != PackageManager.PERMISSION_GRANTED) {
        throw CodedException("RECORD_AUDIO permission not granted")
      }

      currentSampleRate = options.sampleRate ?: 16000

      val fileName = options.fileName ?: "pcm_${System.currentTimeMillis()}.wav"
      val outputFile = File(context.cacheDir, fileName)
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

      audioRecord!!.startRecording()
      isRecordingFlag.set(true)
      startTimeMs.set(System.currentTimeMillis())
      currentFilePath = outputFile.absolutePath

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
      recordingThread?.let { thread ->
        try { thread.join(10_000) } catch (_: InterruptedException) {}
      }
      recordingThread = null

      try { audioRecord?.stop() } catch (_: Exception) {}
      audioRecord?.release()
      audioRecord = null

      val filePath = currentFilePath
      val durationMs = System.currentTimeMillis() - startTimeMs.get()
      val fileSize = filePath?.let { File(it).let { if (it.exists()) it.length() else 0L } } ?: 0L

      sendEvent("onRecordingStopped", mapOf(
        "filePath" to filePath,
        "durationMs" to durationMs,
        "fileSizeBytes" to fileSize
      ))

      mapOf(
        "isRecording" to false,
        "filePath" to filePath,
        "durationMs" to durationMs,
        "fileSizeBytes" to fileSize
      )
    }

    AsyncFunction("cancelRecording") {
      if (isRecordingFlag.get()) {
        isRecordingFlag.set(false)
        recordingThread?.let { try { it.join(5_000) } catch (_: InterruptedException) {} }
        recordingThread = null
        try { audioRecord?.stop() } catch (_: Exception) {}
        audioRecord?.release()
        audioRecord = null
        currentFilePath?.let { File(it).delete() }
        currentFilePath = null
      }
      true
    }

    AsyncFunction("deleteRecording") { filePath: String ->
      File(filePath).let { if (it.exists()) it.delete() else false }
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
    FileOutputStream(outputFile).use { fos ->
      try {
        fos.write(ByteArray(44))
        val readBuffer = ByteArray(bufferSize)
        var totalPcmBytes: Long = 0

        while (isRecordingFlag.get()) {
          val bytesRead = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: -1
          when {
            bytesRead > 0 -> {
              fos.write(readBuffer, 0, bytesRead)
              totalPcmBytes += bytesRead
            }
            bytesRead == 0 -> Thread.sleep(5)
            else -> break
          }
        }
        fos.flush()
        writeWavHeader(outputFile, totalPcmBytes)
        Log.i(TAG, "WAV complete: ${outputFile.name}, ${totalPcmBytes}B")
      } catch (e: Exception) {
        Log.e(TAG, "writeWavFile error", e)
      }
    }
  }

  private fun writeWavHeader(file: File, pcmDataSize: Long) {
    val byteRate = currentSampleRate * NUM_CHANNELS * BITS_PER_SAMPLE / 8
    val blockAlign = NUM_CHANNELS * BITS_PER_SAMPLE / 8
    val safeDataSize = minOf(pcmDataSize, (Int.MAX_VALUE - 36).toLong())

    val header = ByteBuffer.allocate(44).apply {
      order(ByteOrder.LITTLE_ENDIAN)
      put('R'.code.toByte()); put('I'.code.toByte()); put('F'.code.toByte()); put('F'.code.toByte())
      putInt((36 + safeDataSize).toInt())
      put('W'.code.toByte()); put('A'.code.toByte()); put('V'.code.toByte()); put('E'.code.toByte())
      put('f'.code.toByte()); put('m'.code.toByte()); put('t'.code.toByte()); put(' '.code.toByte())
      putInt(16); putShort(1); putShort(NUM_CHANNELS); putInt(currentSampleRate)
      putInt(byteRate); putShort(blockAlign.toShort()); putShort(BITS_PER_SAMPLE)
      put('d'.code.toByte()); put('a'.code.toByte()); put('t'.code.toByte()); put('a'.code.toByte())
      putInt(safeDataSize.toInt())
    }

    RandomAccessFile(file, "rw").use { it.seek(0); it.write(header.array()) }
  }

  private fun forceCleanup() {
    isRecordingFlag.set(false)
    recordingThread?.let { try { it.join(3_000); if (it.isAlive) it.interrupt() } catch (_: Exception) {} }
    recordingThread = null
    try { audioRecord?.stop() } catch (_: Exception) {}
    audioRecord?.release()
    audioRecord = null
  }
}
