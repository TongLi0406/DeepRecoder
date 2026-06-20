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
      embedding TEXT,
      use_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
    CREATE INDEX IF NOT EXISTS idx_skills_merged_into ON skills(merged_into);
  `);
  // Migration: add embedding column
  try { await d.execAsync('ALTER TABLE skills ADD COLUMN embedding TEXT'); } catch {}
}

export async function insertSkill(skill: Skill, embedding?: number[]): Promise<void> {
  const embJson = embedding ? JSON.stringify(embedding) : null;
  if (Platform.OS === "web") {
    const skills = getMem("skills") as Skill[];
    const idx = skills.findIndex((s) => s.id === skill.id);
    if (idx >= 0) skills[idx] = skill; else skills.push(skill);
    return;
  }
  const d = await getNativeDb();
  await d.runAsync(
    `INSERT OR REPLACE INTO skills (id, name, description, category, source_session_ids, merged_from, merged_into, embedding, use_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    skill.id, skill.name, skill.description, skill.category,
    JSON.stringify(skill.sourceSessionIds), JSON.stringify(skill.mergedFrom),
    skill.mergedInto ?? null, embJson, skill.useCount, skill.createdAt, skill.updatedAt,
  );
}

export async function updateSkillEmbedding(id: string, embedding: number[]): Promise<void> {
  if (Platform.OS === "web") return;
  const d = await getNativeDb();
  await d.runAsync('UPDATE skills SET embedding = ? WHERE id = ?', JSON.stringify(embedding), id);
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

// ─── Skill Search (Semantic) ───

interface SkillWithEmbedding {
  skill: Skill;
  embedding: number[];
  similarity: number;
}

export async function searchSkillsByEmbedding(
  queryEmbedding: number[],
  topK = 5,
): Promise<SkillWithEmbedding[]> {
  const d = await getNativeDb();
  const rows = await d.getAllAsync(
    "SELECT * FROM skills WHERE merged_into IS NULL AND embedding IS NOT NULL",
  );

  const results: SkillWithEmbedding[] = [];
  for (const r of rows) {
    const emb = JSON.parse(r.embedding);
    const sim = cosineSimilarity(queryEmbedding, emb);
    results.push({ skill: rowToSkill(r), embedding: emb, similarity: sim });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

// ─── Display Group Helpers ───

export interface SkillDisplayGroup {
  key: string;
  icon: string;
  label: string;
  categories: SkillCategory[];
}

export const SKILL_DISPLAY_GROUPS: SkillDisplayGroup[] = [
  {
    key: "problem_solving_group",
    icon: "🧠",
    label: "解题思路",
    categories: ["problem_solving", "learning_strategy", "knowledge_connection"],
  },
  {
    key: "teaching_group",
    icon: "📖",
    label: "教学思路",
    categories: ["teaching_strategy", "engagement_technique", "question_design", "assessment", "teaching_method"],
  },
  {
    key: "decision_group",
    icon: "📊",
    label: "决策思路",
    categories: ["decision_framework", "meeting_process", "problem_identification", "decision_pattern", "meeting_practice"],
  },
  {
    key: "action_group",
    icon: "✅",
    label: "行动思路",
    categories: ["action_tracking", "communication_insight", "personal_productivity", "communication"],
  },
];

export function getDisplayGroup(category: SkillCategory): SkillDisplayGroup | undefined {
  return SKILL_DISPLAY_GROUPS.find((g) => g.categories.includes(category));
}

export const CATEGORY_LABELS: Record<string, string> = {
  // Classroom-Student
  problem_solving: "解题方法",
  learning_strategy: "学习策略",
  knowledge_connection: "知识关联",
  // Classroom-Teacher
  teaching_strategy: "教学策略",
  engagement_technique: "互动技巧",
  question_design: "提问设计",
  assessment: "评估方法",
  // Meeting-Organizer
  decision_framework: "决策框架",
  meeting_process: "会议流程",
  problem_identification: "问题识别",
  // Meeting-Attendee
  action_tracking: "行动追踪",
  communication_insight: "沟通要点",
  personal_productivity: "个人效能",
  // Legacy
  teaching_method: "教学方法",
  meeting_practice: "会议实践",
  decision_pattern: "决策模式",
  communication: "沟通技巧",
  other: "其他",
};
