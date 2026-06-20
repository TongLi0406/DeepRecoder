import { Platform } from "react-native";
import { generateEmbedding } from "./embedding";
import { debugLog } from "./debug";

// ─── In-Memory Store (Web) ───

const memEmbeds: EmbeddingRow[] = [];
const memQueryTimes: number[] = [];
let memHighLatencyStreak = 0;

// ─── Native DB ───

let nativeDb: any = null;
async function getNativeDb(): Promise<any> {
  if (!nativeDb) {
    const SQLite = await import("expo-sqlite");
    nativeDb = await SQLite.openDatabaseAsync("recorder.db");
  }
  return nativeDb;
}

// ─── Init ───

export async function initEmbeddingsTable(): Promise<void> {
  if (Platform.OS === "web") return;
  const d = await getNativeDb();
  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, content_type TEXT NOT NULL,
      content_text TEXT NOT NULL, embedding TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_embeddings_session ON embeddings(session_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_type ON embeddings(content_type);
  `);
}

// ─── Types ───

export interface EmbeddingRow {
  id: string;
  sessionId: string;
  contentType: string;
  contentText: string;
  embedding: number[];
  createdAt: string;
}

export interface SearchResult {
  embeddingRow: EmbeddingRow;
  similarity: number;
}

// ─── CRUD ───

export async function insertEmbedding(
  sessionId: string, contentType: string, contentText: string, embedding: number[],
): Promise<void> {
  const id = `emb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const row: EmbeddingRow = {
    id, sessionId, contentType, contentText, embedding,
    createdAt: new Date().toISOString(),
  };

  if (Platform.OS === "web") {
    memEmbeds.push(row);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(
    `INSERT INTO embeddings (id, session_id, content_type, content_text, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id, sessionId, contentType, contentText, JSON.stringify(embedding), row.createdAt,
  );
}

export async function getAllEmbeddings(): Promise<EmbeddingRow[]> {
  if (Platform.OS === "web") return [...memEmbeds];
  const d = await getNativeDb();
  const rows = await d.getAllAsync("SELECT * FROM embeddings ORDER BY created_at DESC");
  return rows.map((r: any) => ({
    id: r.id, sessionId: r.session_id, contentType: r.content_type,
    contentText: r.content_text, embedding: JSON.parse(r.embedding),
    createdAt: r.created_at,
  }));
}

// ─── Similarity Search ───

export function cosineSim(a: number[], b: number[]): number {
  let da = 0, db = 0, s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; da += a[i] * a[i]; db += b[i] * b[i]; }
  if (da === 0 || db === 0) return 0;
  return s / (Math.sqrt(da) * Math.sqrt(db));
}

const LATENCY_THRESHOLD = 500;
const MIGRATION_STREAK = 3;

export async function vectorSearch(queryEmbedding: number[], topK = 10): Promise<SearchResult[]> {
  const t0 = Date.now();
  const all = await getAllEmbeddings();

  const scored: SearchResult[] = all.map((row) => ({
    embeddingRow: row,
    similarity: cosineSim(queryEmbedding, row.embedding),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);

  const elapsed = Date.now() - t0;
  const times = Platform.OS === "web" ? memQueryTimes : [];
  times.push(elapsed);
  if (times.length > 100) times.shift();

  let streak = Platform.OS === "web" ? memHighLatencyStreak : 0;
  if (elapsed > LATENCY_THRESHOLD) streak++; else streak = 0;

  if (Platform.OS === "web") memHighLatencyStreak = streak;

  if (streak >= MIGRATION_STREAK) {
    const sorted = [...times].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    console.warn(
      `[VectorStore] p95 ${p95.toFixed(0)}ms exceeds ${LATENCY_THRESHOLD}ms — consider HNSW migration`,
    );
  }

  return scored.slice(0, topK);
}

// ─── Index Session ───

export async function indexSessionSummaries(sessionId: string, summary: any): Promise<void> {
  const items: { type: string; text: string }[] = [];
  if (summary.knowledgePoints) {
    for (const kp of summary.knowledgePoints) {
      items.push({ type: "knowledge_point", text: `${kp.name}: ${kp.description}` });
    }
  }
  if (summary.problemSolvingApproaches) {
    for (const pa of summary.problemSolvingApproaches) {
      items.push({ type: "problem_approach", text: `${pa.approach}: ${pa.procedure}` });
    }
  }
  if (summary.decisions) {
    for (const d of summary.decisions) {
      items.push({ type: "decision", text: `${d.content}: ${d.context ?? ""}` });
    }
  }
  if (summary.actionItems) {
    for (const a of summary.actionItems) {
      items.push({ type: "action_item", text: `${a.content} (${a.assignee ?? ""})` });
    }
  }

  debugLog(`[VectorStore] Indexing ${items.length} items for session ${sessionId.slice(0, 8)}...`);
  let indexed = 0;
  let failed = 0;
  for (const item of items) {
    try {
      const emb = await generateEmbedding(item.text);
      await insertEmbedding(sessionId, item.type, item.text, emb);
      indexed++;
    } catch (e: any) {
      failed++;
      debugLog(`[VectorStore] Failed to index ${item.type}: ${e?.message || e}`);
    }
  }
  debugLog(`[VectorStore] Indexed ${indexed}/${items.length} items (${failed} failed)`);
}

// ─── Keyword Search ───

export function keywordSearch(embeddings: EmbeddingRow[], query: string): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/);
  return embeddings
    .map((row) => {
      const text = row.contentText.toLowerCase();
      let score = 0;
      for (const term of terms) { if (text.includes(term)) score += 1; }
      if (text.includes(query.toLowerCase())) score += 2;
      return { embeddingRow: row, similarity: score / (terms.length + 2) };
    })
    .filter((r) => r.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity);
}
