package expo.modules.pcmrecorder

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.k2fsa.sherpa.onnx.SileroVadModelConfig
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import com.k2fsa.sherpa.onnx.Vad
import com.k2fsa.sherpa.onnx.VadModelConfig
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlin.math.sqrt

internal data class SpeakerWindowEvidence(
  val startMs: Long,
  val endMs: Long,
  val speaker: String,
  val similarity: Double?,
)

internal data class SpeakerEvidenceResult(
  val speaker: String,
  val similarity: Double?,
  val profileRevision: String?,
  val windows: List<SpeakerWindowEvidence>,
)

internal class SherpaVad(modelPath: String) {
  private val vad = Vad(
    assetManager = null,
    config = VadModelConfig(
      sileroVadModelConfig = SileroVadModelConfig(
        model = modelPath,
        threshold = 0.5f,
        minSilenceDuration = 0.25f,
        minSpeechDuration = 0.2f,
        windowSize = 512,
        maxSpeechDuration = 10.0f,
      ),
      sampleRate = DiaryPaths.SAMPLE_RATE,
      numThreads = 1,
      provider = "cpu",
      debug = false,
    ),
  )

  fun computeScore(samples: FloatArray): Float = vad.compute(samples)

  fun release() {
    vad.release()
  }
}

internal object SherpaSpeaker {
  private const val PREFS = "pcm_speaker_profile"
  private const val KEY_ALIAS = "pcm-diary-speaker-profile"
  private const val MATCH_THRESHOLD = 0.80
  private const val ENROLL_MIN_CONSISTENCY = 0.80
  private const val WINDOW_MS = 3000
  private const val HOP_MS = 3000

  fun hasProfile(context: Context): Boolean {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return prefs.contains("revision") && prefs.contains("iv") && prefs.contains("blob")
  }

  fun deleteProfile(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
  }

  fun enroll(context: Context, modelPath: String, wavPath: String) {
    val samples = WavIo.readPcm16MonoAsFloat(File(wavPath))
    val durationSec = samples.size.toDouble() / DiaryPaths.SAMPLE_RATE
    require(durationSec >= 15.0) { "enroll_too_short" }
    require(durationSec <= 30.0) { "enroll_too_long" }

    val extractor = buildExtractor(modelPath)
    try {
      val windows = computeWindowEmbeddings(extractor, samples, WINDOW_MS, HOP_MS)
      require(windows.size >= 4) { "enroll_insufficient_windows" }

      val mean = averageEmbedding(windows)
      val consistencyValues = windows.map { cosineSimilarity(it, mean) }
      val avgConsistency = consistencyValues.average()
      val minConsistency = consistencyValues.minOrNull() ?: 0.0
      require(avgConsistency >= ENROLL_MIN_CONSISTENCY && minConsistency >= ENROLL_MIN_CONSISTENCY) {
        "enroll_not_clean_solo_speech"
      }

      saveProfile(context, mean)
    } finally {
      extractor.release()
    }
  }

  fun identify(context: Context, modelPath: String, wavPath: String): SpeakerEvidenceResult {
    val profile = loadProfile(context) ?: return SpeakerEvidenceResult("unknown", null, null, emptyList())
    val samples = WavIo.readPcm16MonoAsFloat(File(wavPath))
    if (samples.size < DiaryPaths.SAMPLE_RATE * 3) {
      return SpeakerEvidenceResult("unknown", null, profile.revision, emptyList())
    }

    val extractor = buildExtractor(modelPath)
    val windows = try {
      computeWindowEmbeddingsWithOffsets(extractor, samples, WINDOW_MS, HOP_MS)
    } finally {
      extractor.release()
    }

    val evidence = windows.mapNotNull { pair ->
      val emb = pair.second
      if (emb.size != profile.embedding.size || !emb.all { it.isFinite() }) {
        null
      } else {
        val similarity = cosineSimilarity(emb, profile.embedding)
        val matched = similarity >= MATCH_THRESHOLD
        SpeakerWindowEvidence(
          startMs = pair.first.first,
          endMs = pair.first.second,
          speaker = if (matched) "matched" else "unknown",
          similarity = similarity,
        )
      }
    }

    if (evidence.isEmpty()) {
      return SpeakerEvidenceResult("unknown", null, profile.revision, emptyList())
    }

    val usable = evidence.filter { it.similarity != null }
    val matched = usable.filter { it.speaker == "matched" }
    val avg = usable.mapNotNull { it.similarity }.averageOrNull()

    val windowSamples = (DiaryPaths.SAMPLE_RATE * WINDOW_MS) / 1000
    val coveredSamples = windows.size * windowSamples
    val remainderSamples = (samples.size - coveredSamples).coerceAtLeast(0)
    val remainderOkay = remainderSamples <= (windowSamples / 2)
    val enoughSpeech = usable.size >= 3
    val allUsableMatched = matched.size == usable.size

    val speaker = if (enoughSpeech && remainderOkay && allUsableMatched) "matched" else "unknown"

    return SpeakerEvidenceResult(speaker, avg, profile.revision, evidence)
  }

  private fun buildExtractor(modelPath: String): SpeakerExtractor {
    return SpeakerExtractor(modelPath)
  }

  private fun computeWindowEmbeddings(
    extractor: SpeakerExtractor,
    samples: FloatArray,
    windowMs: Int,
    hopMs: Int,
  ): List<FloatArray> {
    return computeWindowEmbeddingsWithOffsets(extractor, samples, windowMs, hopMs).map { it.second }
  }

  private fun computeWindowEmbeddingsWithOffsets(
    extractor: SpeakerExtractor,
    samples: FloatArray,
    windowMs: Int,
    hopMs: Int,
  ): List<Pair<Pair<Long, Long>, FloatArray>> {
    val window = (DiaryPaths.SAMPLE_RATE * windowMs) / 1000
    val hop = (DiaryPaths.SAMPLE_RATE * hopMs) / 1000
    if (samples.size < window) return emptyList()

    val out = mutableListOf<Pair<Pair<Long, Long>, FloatArray>>()
    var offset = 0
    while (offset + window <= samples.size) {
      val chunk = samples.copyOfRange(offset, offset + window)
      val emb = extractor.embedding(chunk)
      require(emb.isNotEmpty() && emb.all { it.isFinite() }) { "speaker_embedding_invalid" }
      val startMs = (offset * 1000L) / DiaryPaths.SAMPLE_RATE
      val endMs = ((offset + window) * 1000L) / DiaryPaths.SAMPLE_RATE
      out.add((startMs to endMs) to emb)
      offset += hop
    }
    return out
  }

  private fun averageEmbedding(embeddings: List<FloatArray>): FloatArray {
    require(embeddings.isNotEmpty())
    val dim = embeddings.first().size
    require(dim > 0) { "speaker_embedding_dimension_invalid" }
    require(embeddings.all { it.size == dim }) { "speaker_embedding_dimension_mismatch" }
    require(embeddings.all { emb -> emb.all { it.isFinite() } }) { "speaker_embedding_non_finite" }
    val out = FloatArray(dim)
    embeddings.forEach { emb ->
      var i = 0
      while (i < dim) {
        out[i] += emb[i]
        i += 1
      }
    }
    var i = 0
    while (i < dim) {
      out[i] /= embeddings.size.toFloat()
      i += 1
    }
    return out
  }

  private fun cosineSimilarity(a: FloatArray, b: FloatArray): Double {
    require(a.size == b.size) { "speaker_embedding_dimension_mismatch" }
    val size = a.size
    var dot = 0.0
    var na = 0.0
    var nb = 0.0
    var i = 0
    while (i < size) {
      val x = a[i].toDouble()
      val y = b[i].toDouble()
      dot += x * y
      na += x * x
      nb += y * y
      i += 1
    }
    if (!dot.isFinite() || !na.isFinite() || !nb.isFinite() || na <= 1e-12 || nb <= 1e-12) return 0.0
    return dot / (sqrt(na) * sqrt(nb))
  }

  private fun saveProfile(context: Context, embedding: FloatArray) {
    require(embedding.isNotEmpty() && embedding.all { it.isFinite() }) { "speaker_profile_invalid" }
    val bytes = ByteBufferUtils.floatsToBytes(embedding)
    val encrypted = encrypt(bytes)
    val revision = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString("revision", revision)
      .putString("iv", Base64.encodeToString(encrypted.first, Base64.NO_WRAP))
      .putString("blob", Base64.encodeToString(encrypted.second, Base64.NO_WRAP))
      .apply()
  }

  private fun loadProfile(context: Context): LoadedProfile? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val revision = prefs.getString("revision", null) ?: return null
    val ivB64 = prefs.getString("iv", null) ?: return null
    val blobB64 = prefs.getString("blob", null) ?: return null
    val iv = Base64.decode(ivB64, Base64.DEFAULT)
    val blob = Base64.decode(blobB64, Base64.DEFAULT)
    val plain = decrypt(iv, blob)
    val embedding = ByteBufferUtils.bytesToFloats(plain)
    if (embedding.isEmpty() || !embedding.all { it.isFinite() }) {
      throw IllegalStateException("speaker_profile_invalid")
    }
    return LoadedProfile(revision, embedding)
  }

  private fun encrypt(plain: ByteArray): Pair<ByteArray, ByteArray> {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
    return cipher.iv to cipher.doFinal(plain)
  }

  private fun decrypt(iv: ByteArray, data: ByteArray): ByteArray {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(128, iv))
    return cipher.doFinal(data)
  }

  private fun getOrCreateKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    val spec = KeyGenParameterSpec.Builder(
      KEY_ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setRandomizedEncryptionRequired(true)
      .build()
    generator.init(spec)
    return generator.generateKey()
  }

  private data class LoadedProfile(val revision: String, val embedding: FloatArray)
}

private class SpeakerExtractor(modelPath: String) {
  private val extractor = SpeakerEmbeddingExtractor(
    assetManager = null,
    config = SpeakerEmbeddingExtractorConfig(
      model = modelPath,
      numThreads = 1,
      debug = false,
      provider = "cpu",
    ),
  )

  fun embedding(samples: FloatArray): FloatArray {
    val stream = extractor.createStream()
    return try {
      stream.acceptWaveform(samples, DiaryPaths.SAMPLE_RATE)
      stream.inputFinished()
      if (extractor.isReady(stream)) {
        extractor.compute(stream)
      } else {
        throw IllegalStateException("speaker_embedding_not_ready")
      }
    } finally {
      stream.release()
    }
  }

  fun release() {
    extractor.release()
  }
}

private object ByteBufferUtils {
  fun floatsToBytes(values: FloatArray): ByteArray {
    val bytes = ByteArray(values.size * 4)
    var i = 0
    while (i < values.size) {
      val bits = java.lang.Float.floatToIntBits(values[i])
      val offset = i * 4
      bytes[offset] = (bits and 0xFF).toByte()
      bytes[offset + 1] = ((bits shr 8) and 0xFF).toByte()
      bytes[offset + 2] = ((bits shr 16) and 0xFF).toByte()
      bytes[offset + 3] = ((bits shr 24) and 0xFF).toByte()
      i += 1
    }
    return bytes
  }

  fun bytesToFloats(bytes: ByteArray): FloatArray {
    val size = bytes.size / 4
    val out = FloatArray(size)
    var i = 0
    while (i < size) {
      val offset = i * 4
      val bits = (bytes[offset].toInt() and 0xFF) or
        ((bytes[offset + 1].toInt() and 0xFF) shl 8) or
        ((bytes[offset + 2].toInt() and 0xFF) shl 16) or
        ((bytes[offset + 3].toInt() and 0xFF) shl 24)
      out[i] = java.lang.Float.intBitsToFloat(bits)
      i += 1
    }
    return out
  }
}

internal fun speakerEvidenceToMap(result: SpeakerEvidenceResult): Map<String, Any?> {
  return mapOf(
    "speaker" to result.speaker,
    "similarity" to result.similarity,
    "profileRevision" to result.profileRevision,
    "windows" to result.windows.map {
      mapOf(
        "startMs" to it.startMs,
        "endMs" to it.endMs,
        "speaker" to it.speaker,
        "similarity" to it.similarity,
      )
    },
  )
}