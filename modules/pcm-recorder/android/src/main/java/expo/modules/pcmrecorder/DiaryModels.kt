package expo.modules.pcmrecorder

import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.UUID

internal data class DiarySegment(
  val id: String,
  val filePath: String,
  val startTime: String,
  val endTime: String,
  val localDate: String,
  val utcOffsetMinutes: Int,
  val durationMs: Long,
)

internal data class DiaryCurrentSegment(
  val id: String,
  val filePath: String,
  val startTime: String,
  val localDate: String,
  val utcOffsetMinutes: Int,
  val startSample: Long,
)

internal data class DiaryManifest(
  val active: Boolean,
  val paused: Boolean,
  val error: String?,
  val current: DiaryCurrentSegment?,
  val segments: List<DiarySegment>,
)

internal object DiaryPaths {
  const val SAMPLE_RATE = 16_000
  const val BITS_PER_SAMPLE: Short = 16
  const val NUM_CHANNELS: Short = 1

  fun diaryRoot(filesDir: File): File = File(filesDir, "pcm-diary")
  fun segmentRoot(filesDir: File): File = File(diaryRoot(filesDir), "segments")
  fun modelRoot(filesDir: File): File = File(diaryRoot(filesDir), "models")
  fun manifestFile(filesDir: File): File = File(diaryRoot(filesDir), "manifest.json")

  fun ensureAll(filesDir: File) {
    diaryRoot(filesDir).mkdirs()
    segmentRoot(filesDir).mkdirs()
    modelRoot(filesDir).mkdirs()
  }

  fun newSegmentFile(filesDir: File): File {
    val id = UUID.randomUUID().toString()
    return File(segmentRoot(filesDir), "seg_${id}.wav")
  }
}

internal object DiaryManifestStore {
  @Synchronized
  fun load(filesDir: File): DiaryManifest {
    DiaryPaths.ensureAll(filesDir)
    val file = DiaryPaths.manifestFile(filesDir)
    if (!file.exists()) {
      return DiaryManifest(active = false, paused = false, error = null, current = null, segments = emptyList())
    }

    return try {
      val root = JSONObject(readManifestAtomic(file))
      val segmentRoot = DiaryPaths.segmentRoot(filesDir).canonicalFile

      val current = root.optJSONObject("current")?.let { obj ->
        val candidate = DiaryCurrentSegment(
          id = obj.getString("id"),
          filePath = obj.getString("filePath"),
          startTime = obj.getString("startTime"),
          localDate = obj.getString("localDate"),
          utcOffsetMinutes = obj.getInt("utcOffsetMinutes"),
          startSample = obj.optLong("startSample", 0L),
        )
        if (isTrustedPath(segmentRoot, candidate.filePath)) candidate else null
      }

      val segments = mutableListOf<DiarySegment>()
      val arr = root.optJSONArray("segments") ?: JSONArray()
      for (i in 0 until arr.length()) {
        val item = arr.getJSONObject(i)
        val candidate = DiarySegment(
          id = item.getString("id"),
          filePath = item.getString("filePath"),
          startTime = item.getString("startTime"),
          endTime = item.getString("endTime"),
          localDate = item.getString("localDate"),
          utcOffsetMinutes = item.getInt("utcOffsetMinutes"),
          durationMs = item.getLong("durationMs"),
        )
        if (isTrustedPath(segmentRoot, candidate.filePath)) {
          segments.add(candidate)
        }
      }

      DiaryManifest(
        active = root.optBoolean("active", false),
        paused = root.optBoolean("paused", false),
        error = root.optString("error", null),
        current = current,
        segments = segments,
      )
    } catch (_: Exception) {
      DiaryManifest(
        active = false,
        paused = false,
        error = "manifest_corrupted",
        current = null,
        segments = scanSegments(filesDir),
      )
    }
  }

  @Synchronized
  fun save(filesDir: File, manifest: DiaryManifest) {
    DiaryPaths.ensureAll(filesDir)
    val root = JSONObject()
    root.put("active", manifest.active)
    root.put("paused", manifest.paused)
    root.put("error", manifest.error)
    root.put("current", manifest.current?.toJson())

    val arr = JSONArray()
    manifest.segments.forEach { arr.put(it.toJson()) }
    root.put("segments", arr)

    writeManifestAtomic(DiaryPaths.manifestFile(filesDir), root.toString())
  }

  @Synchronized
  fun clearCurrentAndDeactivate(filesDir: File, error: String?) {
    val m = load(filesDir)
    save(
      filesDir,
      m.copy(active = false, paused = false, error = error, current = null)
    )
  }

  @Synchronized
  fun upsertCurrent(filesDir: File, current: DiaryCurrentSegment?, active: Boolean, paused: Boolean, error: String?) {
    val m = load(filesDir)
    save(filesDir, m.copy(active = active, paused = paused, error = error, current = current))
  }

  @Synchronized
  fun appendSegment(filesDir: File, segment: DiarySegment) {
    val m = load(filesDir)
    val kept = m.segments.filterNot { it.id == segment.id }
    save(filesDir, m.copy(segments = kept + segment))
  }

  @Synchronized
  fun deleteSegment(filesDir: File, id: String) {
    val m = load(filesDir)
    if (m.active && m.current?.id == id) {
      throw IllegalStateException("segment_active")
    }
    save(filesDir, m.copy(segments = m.segments.filterNot { it.id == id }))
  }

  @Synchronized
  fun recover(filesDir: File): DiaryManifest {
    var m = load(filesDir)

    val current = m.current
    if (current != null) {
      val f = File(current.filePath)
      if (f.exists() && isTrustedPath(DiaryPaths.segmentRoot(filesDir).canonicalFile, current.filePath)) {
        WavIo.finalizeHeader(f, DiaryPaths.SAMPLE_RATE)
        val finalized = buildSegmentFromFile(current.id, f, current.startTime)
        m = m.copy(segments = m.segments.filterNot { it.id == finalized.id } + finalized)
      }
    }

    val existingIds = m.segments.mapTo(mutableSetOf()) { it.id }
    val merged = m.segments.toMutableList()
    for (candidate in scanSegments(filesDir)) {
      if (!existingIds.contains(candidate.id)) {
        merged.add(candidate)
        existingIds.add(candidate.id)
      }
    }

    val recovered = m.copy(active = false, paused = false, current = null, segments = merged)
    save(filesDir, recovered)
    return recovered
  }

  private fun readManifestAtomic(file: File): String {
    val atomic = AtomicFile(file)
    atomic.openRead().use { input ->
      return input.readBytes().toString(Charsets.UTF_8)
    }
  }

  private fun writeManifestAtomic(file: File, content: String) {
    val atomic = AtomicFile(file)
    var output = atomic.startWrite()
    try {
      output.write(content.toByteArray(Charsets.UTF_8))
      output.flush()
      atomic.finishWrite(output)
    } catch (e: IOException) {
      atomic.failWrite(output)
      throw e
    }
  }

  private fun scanSegments(filesDir: File): List<DiarySegment> {
    val root = DiaryPaths.segmentRoot(filesDir)
    if (!root.exists()) return emptyList()
    return root.listFiles()
      ?.asSequence()
      ?.filter { it.isFile && it.name.startsWith("seg_") && it.name.endsWith(".wav") }
      ?.map { file ->
        WavIo.finalizeHeader(file, DiaryPaths.SAMPLE_RATE)
        val id = file.name.removePrefix("seg_").removeSuffix(".wav")
        buildSegmentFromFile(id, file, null)
      }
      ?.sortedBy { it.startTime }
      ?.toList()
      ?: emptyList()
  }

  private fun buildSegmentFromFile(id: String, file: File, startTimeOverride: String?): DiarySegment {
    val ts = Instant.ofEpochMilli(file.lastModified())
    val odt = OffsetDateTime.ofInstant(ts, ZoneId.systemDefault())
    val parsedStart = startTimeOverride?.let { runCatching { Instant.parse(it) }.getOrNull() }
    val startInstant = parsedStart ?: ts
    val startTime = startInstant.toString()
    val durationMs = ((file.length().coerceAtLeast(44L) - 44L) / 2L) * 1000L / DiaryPaths.SAMPLE_RATE.toLong()
    val endTime = startInstant.plusMillis(durationMs).toString()
    return DiarySegment(
      id = id,
      filePath = file.canonicalPath,
      startTime = startTime,
      endTime = endTime,
      localDate = odt.toLocalDate().toString(),
      utcOffsetMinutes = odt.offset.totalSeconds / 60,
      durationMs = durationMs,
    )
  }

  private fun isTrustedPath(segmentRoot: File, candidatePath: String): Boolean {
    val candidate = try {
      File(candidatePath).canonicalFile
    } catch (_: Exception) {
      return false
    }
    val rootPath = segmentRoot.path
    val candidatePathCanonical = candidate.path
    return candidatePathCanonical == rootPath ||
      candidatePathCanonical.startsWith(rootPath + File.separator)
  }
}

private fun DiaryCurrentSegment.toJson(): JSONObject {
  return JSONObject()
    .put("id", id)
    .put("filePath", filePath)
    .put("startTime", startTime)
    .put("localDate", localDate)
    .put("utcOffsetMinutes", utcOffsetMinutes)
    .put("startSample", startSample)
}

private fun DiarySegment.toJson(): JSONObject {
  return JSONObject()
    .put("id", id)
    .put("filePath", filePath)
    .put("startTime", startTime)
    .put("endTime", endTime)
    .put("localDate", localDate)
    .put("utcOffsetMinutes", utcOffsetMinutes)
    .put("durationMs", durationMs)
}

internal fun nowOffsetDateTime(): OffsetDateTime = OffsetDateTime.now(ZoneId.systemDefault())

internal fun nowIsoString(): String = Instant.now().toString()