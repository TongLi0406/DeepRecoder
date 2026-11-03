import { Platform } from "react-native";
import { textBytes } from "./llmContext";
import type {
  DailyDiary,
  DailyDiaryContent,
  DailyDiaryState,
  DiaryManualIdentity,
  DiaryNativeSegment,
  DiaryQueueStats,
  DiaryRetentionDays,
  DiaryRetentionPlan,
  DiarySegment,
  DiarySegmentState,
  DiarySettings,
  DiarySpeakerAuto,
  DiarySpeakerWindow,
} from "../types/diary";

const DEFAULT_CONTENT: DailyDiaryContent = {
  summaryNeutral: "",
  timeline: [],
  topics: [],
  commitments: [],
  unresolved: [],
  caveat: "Sources are references, not proof.",
};

function normalizeDailyContent(content: any): DailyDiaryContent {
  const asArray = (value: any): any[] => (Array.isArray(value) ? value : []);
  return {
    summaryNeutral: typeof content?.summaryNeutral === "string" ? content.summaryNeutral : "",
    timeline: asArray(content?.timeline).map(item => ({
      timeHint: typeof item?.timeHint === "string" ? item.timeHint : "",
      event: typeof item?.event === "string" ? item.event : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    topics: asArray(content?.topics).map(item => ({
      topic: typeof item?.topic === "string" ? item.topic : "",
      details: typeof item?.details === "string" ? item.details : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    commitments: asArray(content?.commitments).map(item => ({
      item: typeof item?.item === "string" ? item.item : "",
      owner: typeof item?.owner === "string" ? item.owner : "",
      due: typeof item?.due === "string" ? item.due : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    unresolved: asArray(content?.unresolved).map(item => ({
      item: typeof item?.item === "string" ? item.item : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    caveat: "Sources are references, not proof.",
  };
}

const memory = {
  settings: new Map<string, string>([
    ["consent_granted", "false"],
    ["retention_days", "7"],
  ]),
  segments: new Map<string, DiarySegment>(),
  daily: new Map<string, DailyDiary>(),
};

let dbPromise: Promise<any> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function asLocalDate(iso: string): string {
  const d = new Date(iso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function safeJsonParse<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function ensureRetentionDays(days: number): DiaryRetentionDays {
  if (days === 1 || days === 7 || days === 30) return days;
  throw new Error("Retention days must be one of 1/7/30");
}

async function getNativeDb(): Promise<any> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const SQLite = await import("expo-sqlite");
      const db = await SQLite.openDatabaseAsync("diary.db");
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS diary_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS diary_segments (
          id TEXT PRIMARY KEY,
          file_path TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          local_date TEXT NOT NULL,
          utc_offset_minutes INTEGER NOT NULL,
          duration_ms INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          transcript TEXT,
          factual_notes TEXT,
          speaker_auto TEXT NOT NULL DEFAULT 'unknown',
          speaker_similarity REAL,
          profile_revision TEXT,
          speaker_windows TEXT NOT NULL DEFAULT '[]',
          manual_identity TEXT NOT NULL DEFAULT 'none',
          manual_identity_note TEXT NOT NULL DEFAULT '',
          audio_deleted INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NOT NULL DEFAULT '',
          retry_count INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS daily_diaries (
          local_date TEXT PRIMARY KEY,
          version INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'dirty',
          notes TEXT NOT NULL DEFAULT '',
          content_json TEXT NOT NULL DEFAULT '{}',
          source_segment_ids TEXT NOT NULL DEFAULT '[]',
          last_error TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_diary_segments_date ON diary_segments(local_date);
        CREATE INDEX IF NOT EXISTS idx_diary_segments_state ON diary_segments(state);
      `);

      try { await db.execAsync("ALTER TABLE diary_segments ADD COLUMN audio_deleted INTEGER NOT NULL DEFAULT 0"); } catch {}

      await db.runAsync("INSERT OR IGNORE INTO diary_settings (key, value) VALUES ('consent_granted', 'false')");
      await db.runAsync("INSERT OR IGNORE INTO diary_settings (key, value) VALUES ('retention_days', '7')");

      return db;
    })().catch(error => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

function rowToSegment(row: any): DiarySegment {
  return {
    id: row.id,
    filePath: row.file_path,
    startTime: row.start_time,
    endTime: row.end_time,
    localDate: row.local_date,
    utcOffsetMinutes: Number(row.utc_offset_minutes ?? 0),
    durationMs: Number(row.duration_ms ?? 0),
    state: row.state as DiarySegmentState,
    transcript: row.transcript ?? "",
    factualNotes: row.factual_notes ?? "",
    speakerAuto: (row.speaker_auto ?? "unknown") as DiarySpeakerAuto,
    speakerSimilarity: row.speaker_similarity ?? null,
    profileRevision: row.profile_revision ?? null,
    speakerWindows: safeJsonParse<DiarySpeakerWindow[]>(row.speaker_windows, []),
    manualIdentity: (row.manual_identity ?? "none") as DiaryManualIdentity,
    manualIdentityNote: row.manual_identity_note ?? "",
    audioDeleted: Number(row.audio_deleted ?? 0) === 1,
    lastError: row.last_error ?? "",
    retryCount: Number(row.retry_count ?? 0),
    updatedAt: row.updated_at ?? nowIso(),
  };
}

function rowToDaily(row: any): DailyDiary {
  const parsed = safeJsonParse<DailyDiaryContent>(row.content_json, DEFAULT_CONTENT);
  return {
    localDate: row.local_date,
    version: Number(row.version ?? 1),
    state: row.state as DailyDiaryState,
    notes: row.notes ?? "",
    content: normalizeDailyContent(parsed),
    sourceSegmentIds: safeJsonParse<string[]>(row.source_segment_ids, []),
    lastError: row.last_error ?? "",
    updatedAt: row.updated_at ?? nowIso(),
  };
}

function defaultNativeStatusSegment(input: DiaryNativeSegment): DiarySegment {
  return {
    id: input.id,
    filePath: input.filePath,
    startTime: input.startTime,
    endTime: input.endTime,
    localDate: input.localDate,
    utcOffsetMinutes: input.utcOffsetMinutes,
    durationMs: input.durationMs,
    state: "pending",
    transcript: "",
    factualNotes: "",
    speakerAuto: "unknown",
    speakerSimilarity: null,
    profileRevision: null,
    speakerWindows: [],
    manualIdentity: "none",
    manualIdentityNote: "",
    audioDeleted: false,
    lastError: "",
    retryCount: 0,
    updatedAt: nowIso(),
  };
}

export async function initDiaryStorage(): Promise<void> {
  if (Platform.OS === "web") return;
  await getNativeDb();
}

export async function getDiarySettings(): Promise<DiarySettings> {
  if (Platform.OS === "web") {
    return {
      consentGranted: memory.settings.get("consent_granted") === "true",
      retentionDays: ensureRetentionDays(Number(memory.settings.get("retention_days") ?? 7)),
    };
  }
  const db = await getNativeDb();
  const rows = await db.getAllAsync("SELECT key, value FROM diary_settings");
  const map = new Map<string, string>();
  for (const row of rows) map.set(row.key, row.value);
  return {
    consentGranted: map.get("consent_granted") === "true",
    retentionDays: ensureRetentionDays(Number(map.get("retention_days") ?? "7")),
  };
}

export async function setDiaryConsent(consentGranted: boolean): Promise<void> {
  const value = consentGranted ? "true" : "false";
  if (Platform.OS === "web") {
    memory.settings.set("consent_granted", value);
    return;
  }
  const db = await getNativeDb();
  await db.runAsync("INSERT OR REPLACE INTO diary_settings (key, value) VALUES ('consent_granted', ?)", value);
}

export async function setDiaryRetentionDays(days: DiaryRetentionDays): Promise<void> {
  ensureRetentionDays(days);
  if (Platform.OS === "web") {
    memory.settings.set("retention_days", String(days));
    return;
  }
  const db = await getNativeDb();
  await db.runAsync("INSERT OR REPLACE INTO diary_settings (key, value) VALUES ('retention_days', ?)", String(days));
}

export async function importNativeDiarySegments(segments: DiaryNativeSegment[]): Promise<{ inserted: number; updated: number; unchanged: number }> {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  if (!segments.length) return { inserted, updated, unchanged };

  if (Platform.OS === "web") {
    for (const segment of segments) {
      const current = memory.segments.get(segment.id);
      if (!current) {
        memory.segments.set(segment.id, defaultNativeStatusSegment(segment));
        inserted += 1;
        continue;
      }
      const changed = current.filePath !== segment.filePath || current.startTime !== segment.startTime || current.endTime !== segment.endTime ||
        current.localDate !== segment.localDate || current.utcOffsetMinutes !== segment.utcOffsetMinutes || current.durationMs !== segment.durationMs;
      if (!changed) {
        unchanged += 1;
        continue;
      }
      memory.segments.set(segment.id, { ...current, ...segment, updatedAt: nowIso() });
      updated += 1;
    }
    return { inserted, updated, unchanged };
  }

  const db = await getNativeDb();
  for (const segment of segments) {
    const found = await db.getFirstAsync("SELECT * FROM diary_segments WHERE id = ?", segment.id);
    if (!found) {
      inserted += 1;
      await db.runAsync(
        `INSERT INTO diary_segments
        (id, file_path, start_time, end_time, local_date, utc_offset_minutes, duration_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        segment.id,
        segment.filePath,
        segment.startTime,
        segment.endTime,
        segment.localDate,
        segment.utcOffsetMinutes,
        segment.durationMs,
        nowIso(),
      );
      continue;
    }
    const changed = found.file_path !== segment.filePath ||
      found.start_time !== segment.startTime ||
      found.end_time !== segment.endTime ||
      found.local_date !== segment.localDate ||
      Number(found.utc_offset_minutes) !== segment.utcOffsetMinutes ||
      Number(found.duration_ms) !== segment.durationMs;

    if (!changed) {
      unchanged += 1;
      continue;
    }

    updated += 1;
    await db.runAsync(
      `UPDATE diary_segments
      SET file_path = ?, start_time = ?, end_time = ?, local_date = ?, utc_offset_minutes = ?, duration_ms = ?, updated_at = ?
      WHERE id = ?`,
      segment.filePath,
      segment.startTime,
      segment.endTime,
      segment.localDate,
      segment.utcOffsetMinutes,
      segment.durationMs,
      nowIso(),
      segment.id,
    );
  }

  return { inserted, updated, unchanged };
}

export async function listDiarySegmentsByDate(localDate: string): Promise<DiarySegment[]> {
  if (Platform.OS === "web") {
    return Array.from(memory.segments.values())
      .filter(item => item.localDate === localDate)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  const db = await getNativeDb();
  const rows = await db.getAllAsync("SELECT * FROM diary_segments WHERE local_date = ? ORDER BY start_time ASC", localDate);
  return rows.map(rowToSegment);
}

export async function listAllDiarySegments(): Promise<DiarySegment[]> {
  if (Platform.OS === "web") {
    return Array.from(memory.segments.values()).sort((a, b) => a.startTime.localeCompare(b.startTime));
  }
  const db = await getNativeDb();
  const rows = await db.getAllAsync("SELECT * FROM diary_segments ORDER BY start_time ASC");
  return rows.map(rowToSegment);
}

export async function listPendingDiarySegments(limit = 10): Promise<DiarySegment[]> {
  if (Platform.OS === "web") {
    return Array.from(memory.segments.values())
      .filter(item => item.state === "pending")
      .sort((a, b) => a.startTime.localeCompare(b.startTime))
      .slice(0, Math.max(1, limit));
  }
  const db = await getNativeDb();
  const rows = await db.getAllAsync(
    "SELECT * FROM diary_segments WHERE state = 'pending' ORDER BY start_time ASC LIMIT ?",
    Math.max(1, limit),
  );
  return rows.map(rowToSegment);
}

export async function getDiarySegment(id: string): Promise<DiarySegment | null> {
  if (Platform.OS === "web") return memory.segments.get(id) ?? null;
  const db = await getNativeDb();
  const row = await db.getFirstAsync("SELECT * FROM diary_segments WHERE id = ?", id);
  return row ? rowToSegment(row) : null;
}

export async function markSegmentState(id: string, state: DiarySegmentState, error = ""): Promise<void> {
  const updatedAt = nowIso();
  if (Platform.OS === "web") {
    const segment = memory.segments.get(id);
    if (!segment) return;
    const retryCount = state === "failed" ? segment.retryCount + 1 : segment.retryCount;
    memory.segments.set(id, { ...segment, state, lastError: error, retryCount, updatedAt });
    return;
  }
  const db = await getNativeDb();
  if (state === "failed") {
    await db.runAsync(
      "UPDATE diary_segments SET state = ?, last_error = ?, retry_count = retry_count + 1, updated_at = ? WHERE id = ?",
      state,
      error,
      updatedAt,
      id,
    );
    return;
  }
  await db.runAsync(
    "UPDATE diary_segments SET state = ?, last_error = ?, updated_at = ? WHERE id = ?",
    state,
    error,
    updatedAt,
    id,
  );
}

export async function markSegmentResult(
  id: string,
  patch: {
    transcript: string;
    factualNotes: string;
    speakerAuto: DiarySpeakerAuto;
    speakerSimilarity: number | null;
    profileRevision: string | null;
    windows: DiarySpeakerWindow[];
  },
): Promise<void> {
  const updatedAt = nowIso();
  if (Platform.OS === "web") {
    const segment = memory.segments.get(id);
    if (!segment) throw new Error(`Segment not found: ${id}`);
    const next: DiarySegment = {
      ...segment,
      state: "done",
      transcript: patch.transcript,
      factualNotes: patch.factualNotes,
      speakerAuto: patch.speakerAuto,
      speakerSimilarity: patch.speakerSimilarity,
      profileRevision: patch.profileRevision,
      speakerWindows: patch.windows,
      lastError: "",
      updatedAt,
    };
    memory.segments.set(id, next);
    await markDayDirty(next.localDate, "late-transcript");
    return;
  }
  const db = await getNativeDb();
  await db.runAsync(
    `UPDATE diary_segments
     SET state = 'done', transcript = ?, factual_notes = ?, speaker_auto = ?, speaker_similarity = ?, profile_revision = ?,
         speaker_windows = ?, last_error = '', updated_at = ?
     WHERE id = ?`,
    patch.transcript,
    patch.factualNotes,
    patch.speakerAuto,
    patch.speakerSimilarity,
    patch.profileRevision,
    JSON.stringify(patch.windows),
    updatedAt,
    id,
  );
  const row = await db.getFirstAsync("SELECT local_date FROM diary_segments WHERE id = ?", id);
  if (row?.local_date) await markDayDirty(row.local_date, "late-transcript");
}

export async function setManualSegmentIdentity(id: string, identity: DiaryManualIdentity, note = ""): Promise<void> {
  if (Platform.OS === "web") {
    const segment = memory.segments.get(id);
    if (!segment) throw new Error(`Segment not found: ${id}`);
    memory.segments.set(id, { ...segment, manualIdentity: identity, manualIdentityNote: note, updatedAt: nowIso() });
    return;
  }
  const db = await getNativeDb();
  await db.runAsync(
    "UPDATE diary_segments SET manual_identity = ?, manual_identity_note = ?, updated_at = ? WHERE id = ?",
    identity,
    note,
    nowIso(),
    id,
  );
}

export async function markDayDirty(localDate: string, reason = "", clearDerived = false): Promise<void> {
  if (Platform.OS === "web") {
    const existing = memory.daily.get(localDate);
    if (!existing) {
      memory.daily.set(localDate, {
        localDate,
        version: 1,
        state: "dirty",
        notes: "",
        content: DEFAULT_CONTENT,
        sourceSegmentIds: [],
        lastError: reason,
        updatedAt: nowIso(),
      });
      return;
    }
    memory.daily.set(localDate, {
      ...existing,
      version: existing.version + 1,
      state: "dirty",
      notes: clearDerived ? "" : existing.notes,
      content: clearDerived ? DEFAULT_CONTENT : existing.content,
      sourceSegmentIds: clearDerived ? [] : existing.sourceSegmentIds,
      lastError: reason,
      updatedAt: nowIso(),
    });
    return;
  }
  const db = await getNativeDb();
  const existing = await db.getFirstAsync("SELECT version FROM daily_diaries WHERE local_date = ?", localDate);
  if (!existing) {
    await db.runAsync(
      `INSERT INTO daily_diaries
      (local_date, version, state, notes, content_json, source_segment_ids, last_error, updated_at)
      VALUES (?, 1, 'dirty', '', ?, '[]', ?, ?)`,
      localDate,
      JSON.stringify(DEFAULT_CONTENT),
      reason,
      nowIso(),
    );
    return;
  }
  if (clearDerived) {
    await db.runAsync(
      "UPDATE daily_diaries SET version = version + 1, state = 'dirty', notes = '', content_json = ?, source_segment_ids = '[]', last_error = ?, updated_at = ? WHERE local_date = ?",
      JSON.stringify(DEFAULT_CONTENT),
      reason,
      nowIso(),
      localDate,
    );
    return;
  }
  await db.runAsync(
    "UPDATE daily_diaries SET version = version + 1, state = 'dirty', last_error = ?, updated_at = ? WHERE local_date = ?",
    reason,
    nowIso(),
    localDate,
  );
}

export async function saveDailyDiaryDraft(
  localDate: string,
  draft: { state: DailyDiaryState; notes: string; sourceSegmentIds: string[] },
): Promise<void> {
  const sourceJson = JSON.stringify(draft.sourceSegmentIds);
  if (Platform.OS === "web") {
    const existing = memory.daily.get(localDate);
    const version = existing ? existing.version + 1 : 1;
    memory.daily.set(localDate, {
      localDate,
      version,
      state: draft.state,
      notes: draft.notes,
      content: existing?.content ?? DEFAULT_CONTENT,
      sourceSegmentIds: draft.sourceSegmentIds,
      lastError: "",
      updatedAt: nowIso(),
    });
    return;
  }
  const db = await getNativeDb();
  const existing = await db.getFirstAsync("SELECT version, content_json FROM daily_diaries WHERE local_date = ?", localDate);
  const version = existing ? Number(existing.version) + 1 : 1;
  const contentJson = existing?.content_json ?? JSON.stringify(DEFAULT_CONTENT);
  await db.runAsync(
    `INSERT OR REPLACE INTO daily_diaries
    (local_date, version, state, notes, content_json, source_segment_ids, last_error, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '', ?)`,
    localDate,
    version,
    draft.state,
    draft.notes,
    contentJson,
    sourceJson,
    nowIso(),
  );
}

async function validateSourceIds(localDate: string, sourceSegmentIds: string[]): Promise<void> {
  const unique = Array.from(new Set(sourceSegmentIds));
  if (!unique.length) return;
  if (Platform.OS === "web") {
    for (const id of unique) {
      const segment = memory.segments.get(id);
      if (!segment || segment.localDate !== localDate || segment.state !== "done") {
        throw new Error(`Invalid source segment ID: ${id}`);
      }
    }
    return;
  }

  const db = await getNativeDb();
  for (const id of unique) {
    const row = await db.getFirstAsync(
      "SELECT id FROM diary_segments WHERE id = ? AND local_date = ? AND state = 'done'",
      id,
      localDate,
    );
    if (!row?.id) throw new Error(`Invalid source segment ID: ${id}`);
  }
}

export async function saveDailyDiary(
  localDate: string,
  payload: { notes: string; sourceSegmentIds: string[]; content: DailyDiaryContent },
  expectedVersion?: number,
): Promise<void> {
  if (textBytes(payload.notes) > 6000) {
    throw new Error("Daily notes exceed 6000-byte budget");
  }
  await validateSourceIds(localDate, payload.sourceSegmentIds);
  const sourceJson = JSON.stringify(Array.from(new Set(payload.sourceSegmentIds)));
  const contentJson = JSON.stringify(payload.content);

  if (Platform.OS === "web") {
    const existing = memory.daily.get(localDate);
    if (typeof expectedVersion === "number" && existing && existing.version !== expectedVersion) {
      throw new Error(`Daily diary version changed during generation for ${localDate}`);
    }
    const version = existing ? existing.version + 1 : 1;
    memory.daily.set(localDate, {
      localDate,
      version,
      state: "ready",
      notes: payload.notes,
      content: payload.content,
      sourceSegmentIds: JSON.parse(sourceJson),
      lastError: "",
      updatedAt: nowIso(),
    });
    return;
  }

  const db = await getNativeDb();
  const existing = await db.getFirstAsync("SELECT version FROM daily_diaries WHERE local_date = ?", localDate);
  if (typeof expectedVersion === "number") {
    const currentVersion = existing ? Number(existing.version) : null;
    if (currentVersion !== expectedVersion) {
      throw new Error(`Daily diary version changed during generation for ${localDate}`);
    }
  }
  const version = existing ? Number(existing.version) + 1 : 1;
  await db.runAsync(
    `INSERT OR REPLACE INTO daily_diaries
    (local_date, version, state, notes, content_json, source_segment_ids, last_error, updated_at)
    VALUES (?, ?, 'ready', ?, ?, ?, '', ?)`,
    localDate,
    version,
    payload.notes,
    contentJson,
    sourceJson,
    nowIso(),
  );
}

export async function markDailyDiaryFailed(localDate: string, error: string): Promise<void> {
  if (Platform.OS === "web") {
    const existing = memory.daily.get(localDate);
    const version = existing ? existing.version + 1 : 1;
    memory.daily.set(localDate, {
      localDate,
      version,
      state: "failed",
      notes: existing?.notes ?? "",
      content: existing?.content ?? DEFAULT_CONTENT,
      sourceSegmentIds: existing?.sourceSegmentIds ?? [],
      lastError: error,
      updatedAt: nowIso(),
    });
    return;
  }
  const db = await getNativeDb();
  const existing = await db.getFirstAsync("SELECT version, notes, content_json, source_segment_ids FROM daily_diaries WHERE local_date = ?", localDate);
  const version = existing ? Number(existing.version) + 1 : 1;
  await db.runAsync(
    `INSERT OR REPLACE INTO daily_diaries
    (local_date, version, state, notes, content_json, source_segment_ids, last_error, updated_at)
    VALUES (?, ?, 'failed', ?, ?, ?, ?, ?)`,
    localDate,
    version,
    existing?.notes ?? "",
    existing?.content_json ?? JSON.stringify(DEFAULT_CONTENT),
    existing?.source_segment_ids ?? "[]",
    error,
    nowIso(),
  );
}

export async function getDailyDiary(localDate: string): Promise<DailyDiary | null> {
  if (Platform.OS === "web") return memory.daily.get(localDate) ?? null;
  const db = await getNativeDb();
  const row = await db.getFirstAsync("SELECT * FROM daily_diaries WHERE local_date = ?", localDate);
  return row ? rowToDaily(row) : null;
}

export async function listDailyDiaryEntries(limit = 30): Promise<DailyDiary[]> {
  if (Platform.OS === "web") {
    return Array.from(memory.daily.values())
      .sort((a, b) => b.localDate.localeCompare(a.localDate))
      .slice(0, Math.max(1, limit));
  }
  const db = await getNativeDb();
  const rows = await db.getAllAsync(
    "SELECT * FROM daily_diaries ORDER BY local_date DESC LIMIT ?",
    Math.max(1, limit),
  );
  return rows.map(rowToDaily);
}

export async function getDiaryQueueStats(): Promise<DiaryQueueStats> {
  const stats: DiaryQueueStats = { pending: 0, transcribing: 0, failed: 0, done: 0, retryableFailed: 0 };
  if (Platform.OS === "web") {
    for (const segment of memory.segments.values()) {
      if (segment.state === "pending") stats.pending += 1;
      if (segment.state === "transcribing") stats.transcribing += 1;
      if (segment.state === "failed") {
        stats.failed += 1;
        if (segment.retryCount < 3) stats.retryableFailed += 1;
      }
      if (segment.state === "done") stats.done += 1;
    }
    return stats;
  }

  const db = await getNativeDb();
  const rows = await db.getAllAsync("SELECT state, retry_count, COUNT(*) as count FROM diary_segments GROUP BY state, retry_count");
  for (const row of rows) {
    const count = Number(row.count ?? 0);
    if (row.state === "pending") stats.pending += count;
    if (row.state === "transcribing") stats.transcribing += count;
    if (row.state === "failed") {
      stats.failed += count;
      if (Number(row.retry_count ?? 0) < 3) stats.retryableFailed += count;
    }
    if (row.state === "done") stats.done += count;
  }
  return stats;
}

export async function recoverDiaryStaleStates(): Promise<{ requeuedSegments: number; recoveredDays: number }> {
  if (Platform.OS === "web") {
    let requeuedSegments = 0;
    let recoveredDays = 0;
    for (const [id, segment] of memory.segments.entries()) {
      if (segment.state === "transcribing") {
        memory.segments.set(id, {
          ...segment,
          state: "pending",
          retryCount: segment.retryCount + 1,
          lastError: "Recovered stale transcribing state",
          updatedAt: nowIso(),
        });
        requeuedSegments += 1;
      }
    }
    for (const [date, daily] of memory.daily.entries()) {
      if (daily.state === "generating") {
        memory.daily.set(date, {
          ...daily,
          state: "dirty",
          version: daily.version + 1,
          lastError: "Recovered stale generating state",
          updatedAt: nowIso(),
        });
        recoveredDays += 1;
      }
    }
    return { requeuedSegments, recoveredDays };
  }

  const db = await getNativeDb();
  const segRow = await db.getFirstAsync("SELECT COUNT(*) as c FROM diary_segments WHERE state = 'transcribing'");
  const dayRow = await db.getFirstAsync("SELECT COUNT(*) as c FROM daily_diaries WHERE state = 'generating'");
  const requeuedSegments = Number(segRow?.c ?? 0);
  const recoveredDays = Number(dayRow?.c ?? 0);
  if (requeuedSegments) {
    await db.runAsync(
      `UPDATE diary_segments
       SET state = 'pending', retry_count = retry_count + 1, last_error = 'Recovered stale transcribing state', updated_at = ?
       WHERE state = 'transcribing'`,
      nowIso(),
    );
  }
  if (recoveredDays) {
    await db.runAsync(
      `UPDATE daily_diaries
       SET state = 'dirty', version = version + 1, last_error = 'Recovered stale generating state', updated_at = ?
       WHERE state = 'generating'`,
      nowIso(),
    );
  }
  return { requeuedSegments, recoveredDays };
}

export async function planRetentionCleanup(nowDateIso = nowIso()): Promise<DiaryRetentionPlan> {
  const settings = await getDiarySettings();
  const cutoffDate = new Date(nowDateIso);
  cutoffDate.setDate(cutoffDate.getDate() - settings.retentionDays);
  const cutoffLocalDate = asLocalDate(cutoffDate.toISOString());

  const plan: DiaryRetentionPlan = {
    cutoffLocalDate,
    deletableSegmentIds: [],
    blockedUnprocessedSegmentIds: [],
  };

  const include = (segment: DiarySegment): void => {
    if (segment.localDate >= cutoffLocalDate) return;
    if (segment.state === "done") {
      plan.deletableSegmentIds.push(segment.id);
      return;
    }
    plan.blockedUnprocessedSegmentIds.push(segment.id);
  };

  if (Platform.OS === "web") {
    for (const segment of memory.segments.values()) include(segment);
    return plan;
  }

  const db = await getNativeDb();
  const rows = await db.getAllAsync(
    "SELECT * FROM diary_segments WHERE local_date < ?",
    cutoffLocalDate,
  );
  for (const row of rows) include(rowToSegment(row));
  return plan;
}

export async function deleteSegmentsByIds(segmentIds: string[]): Promise<void> {
  if (!segmentIds.length) return;
  if (Platform.OS === "web") {
    for (const id of segmentIds) memory.segments.delete(id);
    return;
  }
  const db = await getNativeDb();
  for (const id of segmentIds) {
    await db.runAsync("DELETE FROM diary_segments WHERE id = ?", id);
  }
}

export async function deleteSegment(id: string): Promise<void> {
  if (Platform.OS === "web") {
    memory.segments.delete(id);
    return;
  }
  const db = await getNativeDb();
  await db.runAsync("DELETE FROM diary_segments WHERE id = ?", id);
}

export async function markSegmentAudioDeleted(id: string): Promise<void> {
  if (Platform.OS === "web") {
    const segment = memory.segments.get(id);
    if (!segment) return;
    memory.segments.set(id, { ...segment, audioDeleted: true, updatedAt: nowIso() });
    return;
  }
  const db = await getNativeDb();
  await db.runAsync("UPDATE diary_segments SET audio_deleted = 1, updated_at = ? WHERE id = ?", nowIso(), id);
}

export async function markSegmentsAudioDeleted(segmentIds: string[]): Promise<void> {
  for (const id of segmentIds) {
    await markSegmentAudioDeleted(id);
  }
}

export async function clearAutoSpeakerEvidence(): Promise<{ localDates: string[]; segmentIds: string[] }> {
  if (Platform.OS === "web") {
    const localDates = new Set<string>();
    const segmentIds: string[] = [];
    for (const [id, segment] of memory.segments.entries()) {
      const hasAutoEvidence = segment.speakerAuto !== "unknown" || segment.speakerSimilarity !== null ||
        segment.profileRevision !== null || segment.speakerWindows.length > 0;
      if (!hasAutoEvidence) continue;
      localDates.add(segment.localDate);
      segmentIds.push(id);
      memory.segments.set(id, {
        ...segment,
        speakerAuto: "unknown",
        speakerSimilarity: null,
        profileRevision: null,
        speakerWindows: [],
        updatedAt: nowIso(),
      });
    }
    return { localDates: Array.from(localDates), segmentIds };
  }

  const db = await getNativeDb();
  const rows = await db.getAllAsync(
    `SELECT id, local_date FROM diary_segments
     WHERE speaker_auto != 'unknown' OR speaker_similarity IS NOT NULL OR profile_revision IS NOT NULL OR speaker_windows != '[]'`,
  );
  const localDates = new Set<string>();
  const segmentIds: string[] = [];
  for (const row of rows) {
    localDates.add(row.local_date);
    segmentIds.push(row.id);
  }
  if (segmentIds.length) {
    await db.runAsync(
      "UPDATE diary_segments SET speaker_auto = 'unknown', speaker_similarity = NULL, profile_revision = NULL, speaker_windows = '[]', updated_at = ? WHERE speaker_auto != 'unknown' OR speaker_similarity IS NOT NULL OR profile_revision IS NOT NULL OR speaker_windows != '[]'",
      nowIso(),
    );
  }

  return { localDates: Array.from(localDates), segmentIds };
}

export async function clearAllDiaryData(includeDerived: boolean): Promise<void> {
  if (Platform.OS === "web") {
    memory.segments.clear();
    if (includeDerived) memory.daily.clear();
    return;
  }
  const db = await getNativeDb();
  await db.runAsync("DELETE FROM diary_segments");
  if (includeDerived) await db.runAsync("DELETE FROM daily_diaries");
}
