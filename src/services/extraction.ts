import type { SessionMode, Skill, SkillCategory } from "../types";
import { callLLM } from "./api";
import { insertSkill } from "./skills";

// ─── Extraction Prompts per Mode ───

const EXTRACT_CLASSROOM = `你是一位教育专家。从课堂录音转写中提取可复用的"技能"——方法、技巧、教学模式等。

输出 JSON 数组，每个技能包含：
- name: 简短名称（≤15字）
- description: 详细描述（1-2句话）
- category: 分类，必须是以下之一：problem_solving（解题方法）、teaching_method（教学方法）、other（其他）

严格输出以下格式，不要其他内容：
[{"name": "...", "description": "...", "category": "problem_solving"}]`;

const EXTRACT_MEETING = `你是一位组织管理专家。从会议录音转写中提取可复用的"技能"——决策模式、沟通技巧、流程方法等。

输出 JSON 数组，每个技能包含：
- name: 简短名称（≤15字）
- description: 详细描述（1-2句话）
- category: 分类，必须是以下之一：decision_pattern（决策模式）、meeting_practice（会议实践）、communication（沟通技巧）、other（其他）

严格输出以下格式，不要其他内容：
[{"name": "...", "description": "...", "category": "decision_pattern"}]`;

export async function extractSkills(
  transcript: string,
  mode: SessionMode,
  sessionId: string,
  apiKey?: string,
): Promise<Skill[]> {
  const isClassroom = mode.startsWith("classroom");
  const system = isClassroom ? EXTRACT_CLASSROOM : EXTRACT_MEETING;
  const userMessage = `请从以下录音转写中提取可复用的技能：\n\n${transcript}`;

  const raw = await callLLM(system, userMessage, apiKey, 2048);

  let items: { name: string; description: string; category: string }[];
  try {
    const clean = raw.trim().replace(/```json\s*|```/g, "");
    items = JSON.parse(clean);
    if (!Array.isArray(items)) throw new Error("Not an array");
  } catch {
    return [];
  }

  const now = new Date().toISOString();
  const skills: Skill[] = [];

  for (const item of items) {
    const skill: Skill = {
      id: "sk-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + "-" + skills.length,
      name: item.name,
      description: item.description,
      category: normalizeCategory(item.category),
      sourceSessionIds: [sessionId],
      mergedFrom: [],
      useCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    await insertSkill(skill);
    skills.push(skill);
  }

  return skills;
}

function normalizeCategory(c: string): SkillCategory {
  const valid: SkillCategory[] = [
    "problem_solving", "teaching_method", "meeting_practice",
    "decision_pattern", "communication", "other",
  ];
  if (valid.includes(c as SkillCategory)) return c as SkillCategory;

  // Map common LLM variations
  const mapping: Record<string, SkillCategory> = {
    "解题方法": "problem_solving",
    "教学方法": "teaching_method",
    "决策模式": "decision_pattern",
    "会议实践": "meeting_practice",
    "沟通技巧": "communication",
  };
  return mapping[c] ?? "other";
}
