package expo.modules.pcmrecorder

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.max
import kotlin.math.min

internal object WavIo {
  private const val HEADER_SIZE = 44

  fun writePlaceholderHeader(file: File, sampleRate: Int) {
    if (!file.parentFile.exists()) {
      file.parentFile.mkdirs()
    }
    RandomAccessFile(file, "rw").use { raf ->
      raf.setLength(0)
      raf.write(ByteArray(HEADER_SIZE))
      writeHeader(raf, sampleRate, 0)
    }
  }

  fun finalizeHeader(file: File, sampleRate: Int) {
    if (!file.exists() || file.length() < HEADER_SIZE) return
    val dataSize = max(0L, file.length() - HEADER_SIZE)
    RandomAccessFile(file, "rw").use { raf ->
      writeHeader(raf, sampleRate, dataSize)
    }
  }

  fun readPcm16MonoAsFloat(file: File): FloatArray {
    if (!file.exists() || file.length() <= HEADER_SIZE) return FloatArray(0)
    val pcmBytes = (file.length() - HEADER_SIZE).toInt()
    val numSamples = pcmBytes / 2
    val output = FloatArray(numSamples)
    RandomAccessFile(file, "r").use { raf ->
      raf.seek(HEADER_SIZE.toLong())
      var i = 0
      while (i < numSamples) {
        val lo = raf.read()
        val hi = raf.read()
        if (lo < 0 || hi < 0) break
        val value = ((hi shl 8) or lo).toShort()
        output[i] = value / 32768f
        i += 1
      }
      if (i < numSamples) return output.copyOf(i)
    }
    return output
  }

  fun shortsToFloats(src: ShortArray, size: Int): FloatArray {
    val out = FloatArray(size)
    var i = 0
    while (i < size) {
      out[i] = src[i] / 32768f
      i += 1
    }
    return out
  }

  fun floatsToShorts(src: FloatArray): ShortArray {
    val out = ShortArray(src.size)
    var i = 0
    while (i < src.size) {
      val v = min(1f, max(-1f, src[i]))
      out[i] = (v * 32767f).toInt().toShort()
      i += 1
    }
    return out
  }

  private fun writeHeader(raf: RandomAccessFile, sampleRate: Int, pcmDataSize: Long) {
    val bitsPerSample = DiaryPaths.BITS_PER_SAMPLE
    val numChannels = DiaryPaths.NUM_CHANNELS
    val byteRate = sampleRate * numChannels * bitsPerSample / 8
    val blockAlign = (numChannels * bitsPerSample / 8).toShort()
    val safeDataSize = min(pcmDataSize, (Int.MAX_VALUE - 36).toLong()).toInt()

    val header = ByteBuffer.allocate(HEADER_SIZE).order(ByteOrder.LITTLE_ENDIAN)
    header.put('R'.code.toByte())
    header.put('I'.code.toByte())
    header.put('F'.code.toByte())
    header.put('F'.code.toByte())
    header.putInt(36 + safeDataSize)
    header.put('W'.code.toByte())
    header.put('A'.code.toByte())
    header.put('V'.code.toByte())
    header.put('E'.code.toByte())
    header.put('f'.code.toByte())
    header.put('m'.code.toByte())
    header.put('t'.code.toByte())
    header.put(' '.code.toByte())
    header.putInt(16)
    header.putShort(1)
    header.putShort(numChannels)
    header.putInt(sampleRate)
    header.putInt(byteRate)
    header.putShort(blockAlign)
    header.putShort(bitsPerSample)
    header.put('d'.code.toByte())
    header.put('a'.code.toByte())
    header.put('t'.code.toByte())
    header.put('a'.code.toByte())
    header.putInt(safeDataSize)

    raf.seek(0)
    raf.write(header.array())
  }
}