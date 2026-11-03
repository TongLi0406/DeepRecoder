import { Platform } from "react-native";
import type { Session, SessionPhase } from "../types";

// ─── In-Memory Store (Web fallback) ───

const memoryStore = new Map<string, any>();

function memQuery<T extends Record<string, any>>(
  table: string,
  filter?: (row: T) => boolean,
  orderFn?: (a: T, b: T) => number,
  limit?: number,
): T[] {
  const rows = (memoryStore.get(table) ?? []) as T[];
  let result = filter ? rows.filter(filter) : [...rows];
  if (orderFn) result.sort(orderFn);
  if (limit) result = result.slice(0, limit);
  return result;
}

// ─── SQLite (Native) ───

let db: Promise<any> | null = null;

async function getNativeDb(): Promise<any> {
  if (!db) {
    db = (async () => {
    const SQLite = await import("expo-sqlite");
    const connection = await SQLite.openDatabaseAsync("recorder.db");
    await connection.execAsync(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        end_time TEXT,
        title TEXT,
        mode TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'recording',
        audio_uri TEXT,
        audio_duration REAL DEFAULT 0,
        transcript TEXT,
        summary TEXT,
        course_name TEXT,
        embedding_method TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS processing_checkpoints (
        scope TEXT NOT NULL, operation TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY (scope, operation, input)
      );
    `);

    // Migration: add embedding_method column if upgrading from older schema
    try { await connection.execAsync('ALTER TABLE sessions ADD COLUMN embedding_method TEXT'); } catch {}
    try { await connection.execAsync('ALTER TABLE sessions ADD COLUMN partial_summary TEXT'); } catch {}
    return connection;
    })().catch(error => { db = null; throw error; });
  }
  return db;
}

export async function getProcessingCheckpoint(scope: string, operation: string, input: string): Promise<string | null> {
  if (Platform.OS === "web") return memoryStore.get(JSON.stringify([scope, operation, input])) ?? null;
  const connection = await getNativeDb();
  const row = await connection.getFirstAsync(
    "SELECT result FROM processing_checkpoints WHERE scope = ? AND operation = ? AND input = ?", scope, operation, input,
  );
  return row?.result ?? null;
}

export async function saveProcessingCheckpoint(scope: string, operation: string, input: string, result: string): Promise<void> {
  if (Platform.OS === "web") { memoryStore.set(JSON.stringify([scope, operation, input]), result); return; }
  const connection = await getNativeDb();
  await connection.runAsync("INSERT OR REPLACE INTO processing_checkpoints (scope, operation, input, result) VALUES (?, ?, ?, ?)",
    scope, operation, input, result);
}

export async function deleteProcessingCheckpoints(scope: string, prefix = false): Promise<void> {
  if (Platform.OS === "web") {
    for (const key of memoryStore.keys()) {
      try {
        const parts = JSON.parse(key);
        if (Array.isArray(parts) && typeof parts[0] === "string" &&
            (prefix ? parts[0].startsWith(scope) : parts[0] === scope)) memoryStore.delete(key);
      } catch {}
    }
    return;
  }
  const connection = await getNativeDb();
  await connection.runAsync(prefix
    ? "DELETE FROM processing_checkpoints WHERE instr(scope, ?) = 1"
    : "DELETE FROM processing_checkpoints WHERE scope = ?", scope);
}

export async function updateSessionPartialSummary(id: string, text: string): Promise<void> {
  if (Platform.OS === "web") { memoryStore.set("partial:" + id, text); return; }
  const connection = await getNativeDb();
  await connection.runAsync("UPDATE sessions SET partial_summary = ? WHERE id = ?", text, id);
}

export async function getSessionPartialSummary(id: string): Promise<string> {
  if (Platform.OS === "web") return memoryStore.get("partial:" + id) ?? "";
  const connection = await getNativeDb();
  const row = await connection.getFirstAsync("SELECT partial_summary FROM sessions WHERE id = ?", id);
  return row?.partial_summary ?? "";
}

// ─── Public API ───

export async function insertSession(session: Session): Promise<void> {
  if (Platform.OS === "web") {
    const sessions: Session[] = memoryStore.get("sessions") ?? [];
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) sessions[idx] = session;
    else sessions.push(session);
    memoryStore.set("sessions", sessions);
    return;
  }

  const d = await getNativeDb();
  await d.runAsync(
    `INSERT OR REPLACE INTO sessions
     (id, created_at, end_time, title, mode, phase, audio_uri, audio_duration, transcript, summary, course_name, embedding_method, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    session.id,
    session.createdAt,
    session.endTime ?? null,
    session.title ?? null,
    session.mode,
    session.phase,
    session.audioUri ?? null,
    session.audioDuration ?? 0,
    session.transcript ?? null,
    session.summary ? JSON.stringify(session.summary) : null,
    session.courseName ?? null,
    session.embeddingMethod ?? null,
    session.error ?? null,
  );
}

export async function updateSessionPhase(
  id: string,
  phase: SessionPhase,
  error?: string,
): Promise<void> {
  if (Platform.OS === "web") {
    const sessions: Session[] = memoryStore.get("sessions") ?? [];
    const s = sessions.find((r) => r.id === id);
    if (s) { s.phase = phase; s.error = error; }
    memoryStore.set("sessions", sessions);
    return;
  }

  const d = await getNativeDb();
  if (error) {
    await d.runAsync(`UPDATE sessions SET phase = ?, error = ? WHERE id = ?`, phase, error, id);
  } else {
    await d.runAsync(`UPDATE sessions SET phase = ?, error = NULL WHERE id = ?`, phase, id);
  }
}

export async function updateSessionTranscript(id: string, transcript: string): Promise<void> {
  if (Platform.OS === "web") {
    const sessions: Session[] = memoryStore.get("sessions") ?? [];
    const s = sessions.find((r) => r.id === id);
    if (s) s.transcript = transcript;
    memoryStore.set("sessions", sessions);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(`UPDATE sessions SET transcript = ? WHERE id = ?`, transcript, id);
}

export async function updateSessionSummary(
  id: string,
  summary: any,
  courseName?: string,
  title?: string,
  endTime?: string,
): Promise<void> {
  if (Platform.OS === "web") {
    const sessions: Session[] = memoryStore.get("sessions") ?? [];
    const s = sessions.find((r) => r.id === id);
    if (s) { s.summary = summary; s.courseName = courseName; s.title = title; s.endTime = endTime; }
    memoryStore.set("sessions", sessions);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(
    `UPDATE sessions SET summary = ?, course_name = ?, title = ?, end_time = ? WHERE id = ?`,
    JSON.stringify(summary), courseName ?? null, title ?? null, endTime ?? null, id,
  );
}

export async function updateSessionEmbeddingMethod(id: string, method: string): Promise<void> {
  if (Platform.OS === "web") {
    const sessions: Session[] = memoryStore.get("sessions") ?? [];
    const s = sessions.find((r) => r.id === id);
    if (s) s.embeddingMethod = method;
    memoryStore.set("sessions", sessions);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(`UPDATE sessions SET embedding_method = ? WHERE id = ?`, method, id);
}

export async function getAllSessions(): Promise<Session[]> {
  if (Platform.OS === "web") {
    return ((memoryStore.get("sessions") ?? []) as Session[])
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const d = await getNativeDb();
  const rows = await d.getAllAsync(`SELECT * FROM sessions ORDER BY created_at DESC`);
  return rows.map(rowToSession);
}

export async function getSessionById(id: string): Promise<Session | null> {
  if (Platform.OS === "web") {
    const sessions: Session[] = memoryStore.get("sessions") ?? [];
    return sessions.find((s) => s.id === id) ?? null;
  }
  const d = await getNativeDb();
  const row = await d.getFirstAsync(`SELECT * FROM sessions WHERE id = ?`, id);
  return row ? rowToSession(row) : null;
}

export async function deleteSession(id: string): Promise<void> {
  if (Platform.OS === "web") {
    const sessions: Session[] = (memoryStore.get("sessions") ?? [])
      .filter((s: Session) => s.id !== id);
    memoryStore.set("sessions", sessions);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(`DELETE FROM sessions WHERE id = ?`, id);
}

function rowToSession(r: any): Session {
  return {
    id: r.id,
    createdAt: r.created_at,
    endTime: r.end_time ?? undefined,
    title: r.title ?? undefined,
    mode: r.mode,
    phase: r.phase as SessionPhase,
    audioUri: r.audio_uri ?? "",
    audioDuration: r.audio_duration,
    transcript: r.transcript ?? undefined,
    summary: r.summary ? JSON.parse(r.summary) : undefined,
    courseName: r.course_name ?? undefined,
    embeddingMethod: r.embedding_method ?? undefined,
    error: r.error ?? undefined,
  };
}
