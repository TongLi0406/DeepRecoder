import { Platform } from "react-native";

// ─── Types ───

export type JobType = "transcribe" | "summarize" | "extract_skills" | "index_embeddings";
export type JobStatus = "pending" | "processing" | "done" | "failed";

export interface Job {
  id: string;
  type: JobType;
  sessionId: string;
  status: JobStatus;
  payload: Record<string, any>;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ─── In-Memory Store (Web) ───

const memJobs: Job[] = [];

// ─── Native DB ───

let nativeDb: any = null;
async function getNativeDb(): Promise<any> {
  if (!nativeDb) {
    const SQLite = await import("expo-sqlite");
    nativeDb = await SQLite.openDatabaseAsync("recorder.db");
  }
  return nativeDb;
}

export async function initQueueTable(): Promise<void> {
  if (Platform.OS === "web") return;
  const d = await getNativeDb();
  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, session_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', payload TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_job_status ON job_queue(status);
    CREATE INDEX IF NOT EXISTS idx_job_session ON job_queue(session_id);
  `);
}

export async function enqueueJob(
  type: JobType, sessionId: string, payload: Record<string, any> = {}, maxAttempts = 3,
): Promise<string> {
  const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const job: Job = { id, type, sessionId, status: "pending", payload, attempts: 0, maxAttempts, createdAt: now, updatedAt: now };

  if (Platform.OS === "web") { memJobs.push(job); return id; }

  const d = await getNativeDb();
  await d.runAsync(
    `INSERT INTO job_queue (id, type, session_id, status, payload, max_attempts, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
    id, type, sessionId, JSON.stringify(payload), maxAttempts, now, now,
  );
  return id;
}

export async function getPendingJobs(limit = 10): Promise<Job[]> {
  if (Platform.OS === "web") {
    return memJobs.filter((j) => j.status === "pending").slice(0, limit);
  }
  const d = await getNativeDb();
  const rows = await d.getAllAsync(
    "SELECT * FROM job_queue WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?", limit,
  );
  return rows.map(rowToJob);
}

export async function getPendingCount(): Promise<number> {
  if (Platform.OS === "web") return memJobs.filter((j) => j.status === "pending").length;
  const d = await getNativeDb();
  const row = await d.getFirstAsync("SELECT COUNT(*) as count FROM job_queue WHERE status = 'pending'");
  return row?.count ?? 0;
}

export async function markJobRunning(id: string): Promise<void> {
  if (Platform.OS === "web") {
    const j = memJobs.find((x) => x.id === id); if (j) { j.status = "processing"; j.updatedAt = new Date().toISOString(); }
    return;
  }
  const d = await getNativeDb();
  await d.runAsync("UPDATE job_queue SET status = 'processing', updated_at = ? WHERE id = ?", new Date().toISOString(), id);
}

export async function markJobDone(id: string): Promise<void> {
  if (Platform.OS === "web") {
    const j = memJobs.find((x) => x.id === id); if (j) { j.status = "done"; j.updatedAt = new Date().toISOString(); }
    return;
  }
  const d = await getNativeDb();
  await d.runAsync("UPDATE job_queue SET status = 'done', updated_at = ? WHERE id = ?", new Date().toISOString(), id);
}

export async function markJobFailed(id: string, error: string): Promise<void> {
  if (Platform.OS === "web") {
    const j = memJobs.find((x) => x.id === id);
    if (j) { j.attempts++; if (j.attempts >= j.maxAttempts) j.status = "failed"; else j.status = "pending"; j.error = error; }
    return;
  }
  const d = await getNativeDb();
  const row = await d.getFirstAsync("SELECT * FROM job_queue WHERE id = ?", id);
  if (!row) return;
  const job = rowToJob(row);
  const attempts = job.attempts + 1;
  if (attempts >= job.maxAttempts) {
    await d.runAsync("UPDATE job_queue SET status = 'failed', attempts = ?, error = ?, updated_at = ? WHERE id = ?", attempts, error, new Date().toISOString(), id);
  } else {
    await d.runAsync("UPDATE job_queue SET status = 'pending', attempts = ?, error = ?, updated_at = ? WHERE id = ?", attempts, error, new Date().toISOString(), id);
  }
}

export async function checkConnectivity(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch("https://api.deepseek.com/anthropic/v1/models", { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch { return false; }
}

type JobProcessor = (job: Job) => Promise<void>;
const processors = new Map<JobType, JobProcessor>();

export function registerProcessor(type: JobType, fn: JobProcessor): void { processors.set(type, fn); }

export async function drainQueue(): Promise<{ processed: number; failed: number }> {
  let processed = 0, failed = 0;
  const online = await checkConnectivity();
  if (!online) return { processed, failed };
  const jobs = await getPendingJobs(5);
  for (const job of jobs) {
    const processor = processors.get(job.type);
    if (!processor) continue;
    await markJobRunning(job.id);
    try { await processor(job); await markJobDone(job.id); processed++; }
    catch (e: any) { await markJobFailed(job.id, e.message ?? "Unknown"); failed++; }
  }
  return { processed, failed };
}

export async function retryFailedJobs(): Promise<number> {
  if (Platform.OS === "web") {
    let n = 0;
    for (const j of memJobs) { if (j.status === "failed") { j.status = "pending"; j.attempts = 0; j.error = undefined; n++; } }
    return n;
  }
  const d = await getNativeDb();
  const r = await d.runAsync("UPDATE job_queue SET status = 'pending', attempts = 0, error = NULL, updated_at = ? WHERE status = 'failed'", new Date().toISOString());
  return (r as any).changes ?? 0;
}

function rowToJob(r: any): Job {
  return {
    id: r.id, type: r.type, sessionId: r.session_id, status: r.status,
    payload: r.payload ? JSON.parse(r.payload) : {}, attempts: r.attempts,
    maxAttempts: r.max_attempts, error: r.error ?? undefined,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
