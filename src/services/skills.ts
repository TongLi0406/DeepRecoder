import { Platform } from "react-native";
import type { Skill, SkillCategory, ConsolidationCandidate } from "../types";

// ─── In-Memory Store (Web) ───

const mem = new Map<string, any[]>();

function getMem(table: string): any[] {
  if (!mem.has(table)) mem.set(table, []);
  return mem.get(table)!;
}

// ─── Native DB ───

let nativeDb: any = null;
async function getNativeDb(): Promise<any> {
  if (!nativeDb) {
    const SQLite = await import("expo-sqlite");
    nativeDb = await SQLite.openDatabaseAsync("recorder.db");
  }
  return nativeDb;
}

// ─── Public API ───

export async function initSkillsTable(): Promise<void> {
  if (Platform.OS === "web") return;
  const d = await getNativeDb();
  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other', source_session_ids TEXT NOT NULL DEFAULT '[]',
      merged_from TEXT NOT NULL DEFAULT '[]', merged_into TEXT,
      use_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
    CREATE INDEX IF NOT EXISTS idx_skills_merged_into ON skills(merged_into);
  `);
}

export async function insertSkill(skill: Skill): Promise<void> {
  if (Platform.OS === "web") {
    const skills = getMem("skills") as Skill[];
    const idx = skills.findIndex((s) => s.id === skill.id);
    if (idx >= 0) skills[idx] = skill; else skills.push(skill);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(
    `INSERT OR REPLACE INTO skills (id, name, description, category, source_session_ids, merged_from, merged_into, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    skill.id, skill.name, skill.description, skill.category,
    JSON.stringify(skill.sourceSessionIds), JSON.stringify(skill.mergedFrom),
    skill.mergedInto ?? null, skill.useCount, skill.createdAt, skill.updatedAt,
  );
}

export async function getAllSkills(): Promise<Skill[]> {
  if (Platform.OS === "web") {
    return ((getMem("skills") as Skill[]).filter((s) => !s.mergedInto))
      .sort((a, b) => b.useCount - a.useCount);
  }
  const d = await getNativeDb();
  const rows = await d.getAllAsync(
    "SELECT * FROM skills WHERE merged_into IS NULL ORDER BY use_count DESC",
  );
  return rows.map(rowToSkill);
}

export async function getSkillsByCategory(category: SkillCategory): Promise<Skill[]> {
  if (Platform.OS === "web") {
    return (getMem("skills") as Skill[])
      .filter((s) => s.category === category && !s.mergedInto)
      .sort((a, b) => b.useCount - a.useCount);
  }
  const d = await getNativeDb();
  const rows = await d.getAllAsync(
    "SELECT * FROM skills WHERE category = ? AND merged_into IS NULL ORDER BY use_count DESC",
    category,
  );
  return rows.map(rowToSkill);
}

export async function getSkillById(id: string): Promise<Skill | null> {
  if (Platform.OS === "web") {
    return (getMem("skills") as Skill[]).find((s) => s.id === id) ?? null;
  }
  const d = await getNativeDb();
  const row = await d.getFirstAsync("SELECT * FROM skills WHERE id = ?", id);
  return row ? rowToSkill(row) : null;
}

export async function incrementUseCount(id: string): Promise<void> {
  if (Platform.OS === "web") {
    const skills = getMem("skills") as Skill[];
    const s = skills.find((x) => x.id === id);
    if (s) { s.useCount++; s.updatedAt = new Date().toISOString(); }
    return;
  }
  const d = await getNativeDb();
  await d.runAsync("UPDATE skills SET use_count = use_count + 1, updated_at = ? WHERE id = ?",
    new Date().toISOString(), id);
}

export async function mergeSkills(parent: Skill, childIds: string[]): Promise<Skill> {
  const now = new Date().toISOString();
  for (const childId of childIds) {
    const child = await getSkillById(childId);
    if (!child) continue;
    for (const sid of child.sourceSessionIds) {
      if (!parent.sourceSessionIds.includes(sid)) parent.sourceSessionIds.push(sid);
    }
    if (!parent.mergedFrom.includes(childId)) parent.mergedFrom.push(childId);
    for (const mf of child.mergedFrom) {
      if (!parent.mergedFrom.includes(mf)) parent.mergedFrom.push(mf);
    }
    child.mergedInto = parent.id;
    child.updatedAt = now;
    await insertSkill(child);
  }
  parent.useCount += childIds.length;
  parent.updatedAt = now;
  await insertSkill(parent);
  return parent;
}

// ─── Similarity ───

function dot(a: number[], b: number[]): number { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a: number[]): number { let s = 0; for (const v of a) s += v * v; return Math.sqrt(s); }

export function cosineSimilarity(a: number[], b: number[]): number {
  const na = norm(a), nb = norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot(a, b) / (na * nb);
}

export function textToEmbedding(text: string, dim = 128): number[] {
  const vec = new Array(dim).fill(0);
  const normalized = text.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "");
  for (let i = 0; i < normalized.length - 2; i++) {
    const trigram = normalized.slice(i, i + 3);
    let hash = 0;
    for (let j = 0; j < trigram.length; j++) hash = ((hash << 5) - hash + trigram.charCodeAt(j)) | 0;
    vec[Math.abs(hash) % dim] += 1;
  }
  return vec;
}

export function findConsolidationCandidates(skills: Skill[], threshold = 0.75): ConsolidationCandidate[] {
  const pairs: ConsolidationCandidate[] = [];
  const embeddings = skills.map((s) => textToEmbedding(s.name + " " + s.description));
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      if (skills[i].category !== skills[j].category) continue;
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      if (sim >= threshold) pairs.push({ skillA: skills[i], skillB: skills[j], similarity: sim });
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

function rowToSkill(r: any): Skill {
  return {
    id: r.id, name: r.name, description: r.description, category: r.category as SkillCategory,
    sourceSessionIds: JSON.parse(r.source_session_ids), mergedFrom: JSON.parse(r.merged_from),
    mergedInto: r.merged_into ?? undefined, useCount: r.use_count,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
