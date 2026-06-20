import type { SessionMode, Skill, SkillCategory } from "../types";
import { callLLM } from "./api";
import { insertSkill, updateSkillEmbedding } from "./skills";
import { generateEmbedding } from "./embedding";

// ─── Per-Mode Extraction Prompts ───

const EXTRACT_STUDENT = `你是一位学习教练。从课堂录音转写中提取学生的"解题思路"和"学习方法"。

输出 JSON 数组，每个技能包含：
- name: 简短名称（≤15字），如"配方法求最值"
- description: 详细描述（1-2句话），说明方法是什么、怎么用
- category: 分类，必须是以下之一：
  problem_solving（解题方法）— 具体题型的解法、步骤、技巧
  learning_strategy（学习策略）— 高效学习的方法论，如"先看例题再做题"
  knowledge_connection（知识关联）— 跨知识点、跨学科的联结

严格输出以下格式，不要其他内容：
[{"name": "...", "description": "...", "category": "problem_solving"}]`;

const EXTRACT_TEACHER = `你是一位教学研究员。从课堂录音转写中提取教师的"教学思路"和"课堂技巧"。

输出 JSON 数组，每个技能包含：
- name: 简短名称（≤15字），如"由旧引新的导入法"
- description: 详细描述（1-2句话），说明技巧是什么、何时用
- category: 分类，必须是以下之一：
  teaching_strategy（教学策略）— 课程设计、课堂组织、节奏控制
  engagement_technique（互动技巧）— 提问、引导、激发参与的方式
  question_design（提问设计）— 问题链、开放/封闭问题组合
  assessment（评估方法）— 学习效果检验、即时反馈方式

严格输出以下格式，不要其他内容：
[{"name": "...", "description": "...", "category": "teaching_strategy"}]`;

const EXTRACT_ORGANIZER = `你是一位组织管理顾问。从会议录音转写中提取"决策思路"和"会议方法"。

输出 JSON 数组，每个技能包含：
- name: 简短名称（≤15字），如"多方案权衡矩阵"
- description: 详细描述（1-2句话），说明方法是什么、适用场景
- category: 分类，必须是以下之一：
  decision_framework（决策框架）— 多方案比较、权衡方法、决策流程
  meeting_process（会议流程）— 议程设计、时间分配、推进技巧
  problem_identification（问题识别）— 需求澄清、风险预判、边界界定

严格输出以下格式，不要其他内容：
[{"name": "...", "description": "...", "category": "decision_framework"}]`;

const EXTRACT_ATTENDEE = `你是一位个人效能教练。从会议录音转写中提取个人的"行动思路"和"沟通要点"。

输出 JSON 数组，每个技能包含：
- name: 简短名称（≤15字），如"24小时复盘法"
- description: 详细描述（1-2句话），说明方法是什么、怎么用
- category: 分类，必须是以下之一：
  action_tracking（行动追踪）— 任务跟进、DDL管理、复盘方法
  communication_insight（沟通要点）— 言外之意、关键信息捕捉、确认技巧
  personal_productivity（个人效能）— 笔记方法、信息整理、时间管理

严格输出以下格式，不要其他内容：
[{"name": "...", "description": "...", "category": "action_tracking"}]`;

function getPrompt(mode: SessionMode): string {
  switch (mode) {
    case "classroom-student": return EXTRACT_STUDENT;
    case "classroom-teacher": return EXTRACT_TEACHER;
    case "meeting-organizer": return EXTRACT_ORGANIZER;
    case "meeting-attendee": return EXTRACT_ATTENDEE;
  }
}

export async function extractSkills(
  transcript: string,
  mode: SessionMode,
  sessionId: string,
  apiKey?: string,
): Promise<Skill[]> {
  const system = getPrompt(mode);
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
    // Generate embedding for semantic search
    try {
      const emb = await generateEmbedding(skill.name + ": " + skill.description);
      await updateSkillEmbedding(skill.id, emb);
    } catch { /* embedding failed, skill still usable */ }
    skills.push(skill);
  }

  return skills;
}

function normalizeCategory(c: string): SkillCategory {
  const valid: SkillCategory[] = [
    "problem_solving", "learning_strategy", "knowledge_connection",
    "teaching_strategy", "engagement_technique", "question_design", "assessment",
    "decision_framework", "meeting_process", "problem_identification",
    "action_tracking", "communication_insight", "personal_productivity",
    "teaching_method", "meeting_practice", "decision_pattern", "communication", "other",
  ];
  if (valid.includes(c as SkillCategory)) return c as SkillCategory;

  // Map LLM output variations to standard categories
  const mapping: Record<string, SkillCategory> = {
    "解题方法": "problem_solving",
    "学习策略": "learning_strategy",
    "知识关联": "knowledge_connection",
    "教学策略": "teaching_strategy",
    "互动技巧": "engagement_technique",
    "提问设计": "question_design",
    "评估方法": "assessment",
    "决策框架": "decision_framework",
    "会议流程": "meeting_process",
    "问题识别": "problem_identification",
    "行动追踪": "action_tracking",
    "沟通要点": "communication_insight",
    "个人效能": "personal_productivity",
    // Legacy
    "教学方法": "teaching_strategy",
    "会议实践": "meeting_process",
    "决策模式": "decision_framework",
    "沟通技巧": "communication_insight",
  };
  return mapping[c] ?? "other";
}
