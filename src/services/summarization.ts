import type { SessionMode, StudentSummary, TeacherSummary, MeetingSummary } from "../types";
import { callLLM } from "./api";
import { debugLog } from "./debug";

// ─── Prompt Templates ───

const STUDENT_SYSTEM = `你是学习分析助手。分析课堂录音转写，输出结构化 JSON。

规则：
1. 识别转写中的不同发言人，标注为"老师"和"学生"（根据上下文推断）
2. 生成带发言人标签的完整文字记录（speakerLabeledTranscript），格式：角色：说话内容
3. 提炼知识点、解题方法、知识点关联
4. 生成标题（包含课程主题和时间范围）

输出格式（严格输出以下 JSON，不要其他内容）：
{
  "title": "课程主题 (HH:MM-HH:MM)",
  "courseName": "课程名称",
  "speakerLabeledTranscript": "老师：...\\n学生：...",
  "knowledgePoints": [
    {"name": "知识点名称", "description": "详细解释", "category": "分类", "masteryHint": "掌握建议"}
  ],
  "problemSolvingApproaches": [
    {"approach": "方法名", "usedFor": ["适用场景"], "procedure": "具体步骤"}
  ],
  "interLessonConnections": [
    {"connection": "关联名", "description": "关联说明", "relatedTopic": "关联主题"}
  ]
}`;

const TEACHER_SYSTEM = `你是课堂教学分析助手。分析课堂录音转写，从教师视角输出结构化 JSON。

规则：
1. 识别发言人（老师/学生），生成带标签的完整文字记录（speakerLabeledTranscript）
2. 提炼知识点、解题方法、关联
3. 分析教学结构、提问质量、学生参与度
4. 提出改进建议
5. 生成标题（含课程主题和时间范围）

输出格式（严格输出以下 JSON，不要其他内容）：
{
  "title": "课程主题 (HH:MM-HH:MM)",
  "courseName": "课程名称",
  "speakerLabeledTranscript": "老师：...\\n学生：...",
  "teachingStyle": "讲授型/互动型/讨论型/练习型",
  "interactionLevel": "高/中/低",
  "teachingStructure": [
    {"section": "环节名称", "description": "内容描述", "durationHint": "时长估计"}
  ],
  "questionTypes": [
    {"type": "问题类型", "count": 数字, "examples": ["示例问题"], "quality": "评价"}
  ],
  "studentEngagement": {
    "pattern": "参与模式描述",
    "highlights": ["亮点"],
    "concerns": ["需要关注的问题"]
  },
  "knowledgePoints": [
    {"name": "知识点名称", "description": "详细解释", "category": "分类", "masteryHint": "掌握建议"}
  ],
  "problemSolvingApproaches": [
    {"approach": "方法名", "usedFor": ["适用场景"], "procedure": "具体步骤"}
  ],
  "interLessonConnections": [
    {"connection": "关联名", "description": "关联说明", "relatedTopic": "关联主题"}
  ],
  "improvementSuggestions": ["改进建议1", "改进建议2"]
}`;

const MEETING_ORGANIZER_SYSTEM = `你是会议记录分析助手。分析会议录音转写，输出结构化会议纪要。

规则：
1. 识别不同发言人（标注为"发言人A"、"发言人B"等）
2. 生成带发言人标签的完整文字记录（speakerLabeledTranscript）
3. 提炼决策（含背景）、行动项（含负责人和截止时间）、关键要点
4. 生成会议标题（会议主题 + 时间范围）

输出格式（严格输出以下 JSON，不要其他内容）：
{
  "title": "会议主题 (HH:MM-HH:MM)",
  "attendees": ["发言人A", "发言人B"],
  "speakerLabeledTranscript": "发言人A：...\\n发言人B：...",
  "decisions": [
    {"content": "决策内容", "context": "决策背景"}
  ],
  "actionItems": [
    {"content": "行动项", "assignee": "负责人", "deadline": "截止时间"}
  ],
  "problems": ["讨论的问题"],
  "goals": ["会议目标"],
  "keyPoints": ["关键讨论点"]
}`;

const MEETING_ATTENDEE_SYSTEM = `你是个人会议助理。分析会议录音转写，从参会者个人视角输出结构化笔记。

规则：
1. 识别不同发言人（标注为"发言人A"、"发言人B"等）
2. 生成带发言人标签的完整文字记录（speakerLabeledTranscript）
3. 重点提炼与"我"相关的决策、行动项、要点

输出格式（严格输出以下 JSON，不要其他内容）：
{
  "title": "会议主题 (HH:MM-HH:MM)",
  "attendees": ["发言人A", "发言人B"],
  "speakerLabeledTranscript": "发言人A：...\\n发言人B：...",
  "decisions": [
    {"content": "决策内容", "context": "决策背景"}
  ],
  "actionItems": [
    {"content": "行动项", "assignee": "负责人", "deadline": "截止时间"}
  ],
  "problems": [],
  "goals": [],
  "keyPoints": ["关键要点"]
}`;

// ─── Helpers ───

function extractJSON(raw: string): any {
  const clean = raw.trim();

  // Try code block first
  const fenceMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim());

  // Try to find the outermost JSON object/array
  const jsonMatch = clean.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) return JSON.parse(jsonMatch[1]);

  // Fallback: try parsing directly
  return JSON.parse(clean);
}

function addIds<T extends { id?: string }>(arr: T[]): T[] {
  let i = 0;
  return arr.map((item) => ({ ...item, id: String(++i) }));
}

function timeRange(startISO: string, endISO: string): string {
  const fmt = (iso: string) => {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  return `${fmt(startISO)}-${fmt(endISO)}`;
}

// ─── Public API ───

export async function summarize(
  transcript: string,
  mode: SessionMode,
  startTime: string,
  endTime: string,
  apiKey?: string,
): Promise<{
  title: string;
  courseName?: string;
  speakerLabeledTranscript: string;
  summary: StudentSummary | TeacherSummary | MeetingSummary;
}> {
  const timeLabel = timeRange(startTime, endTime);
  const dateStr = new Date(startTime).toISOString().split("T")[0];

  let system: string;
  let userMessage: string;

  switch (mode) {
    case "classroom-student":
      system = STUDENT_SYSTEM;
      userMessage = `录音日期：${dateStr}\n录音时间范围：${timeLabel}\n\n录音转写内容：\n${transcript}\n\n请分析以上课堂录音，生成结构化笔记。`;
      break;
    case "classroom-teacher":
      system = TEACHER_SYSTEM;
      userMessage = `录音日期：${dateStr}\n录音时间范围：${timeLabel}\n\n录音转写内容：\n${transcript}\n\n请从教师视角分析以上课堂录音。`;
      break;
    case "meeting-organizer":
      system = MEETING_ORGANIZER_SYSTEM;
      userMessage = `会议日期：${dateStr}\n会议时间范围：${timeLabel}\n\n会议录音转写：\n${transcript}\n\n请生成结构化会议纪要。`;
      break;
    case "meeting-attendee":
      system = MEETING_ATTENDEE_SYSTEM;
      userMessage = `会议日期：${dateStr}\n会议时间范围：${timeLabel}\n\n会议录音转写：\n${transcript}\n\n请从参会者个人视角整理会议笔记。`;
      break;
  }

  const raw = await callLLM(system, userMessage, apiKey);

  try {
    const parsed = extractJSON(raw);
    debugLog(`[Summarize] Parsed keys: ${Object.keys(parsed).join(', ')}`);
    debugLog(`[Summarize] knowledgePoints: ${parsed.knowledgePoints?.length ?? 0}, decisions: ${parsed.decisions?.length ?? 0}, actionItems: ${parsed.actionItems?.length ?? 0}, problemSolving: ${parsed.problemSolvingApproaches?.length ?? 0}`);
    if (parsed.knowledgePoints) parsed.knowledgePoints = addIds(parsed.knowledgePoints);
    if (parsed.problemSolvingApproaches) parsed.problemSolvingApproaches = addIds(parsed.problemSolvingApproaches);
    if (parsed.interLessonConnections) parsed.interLessonConnections = addIds(parsed.interLessonConnections);
    if (parsed.decisions) parsed.decisions = addIds(parsed.decisions);
    if (parsed.actionItems) parsed.actionItems = addIds(parsed.actionItems);

    const speakerLabeledTranscript = parsed.speakerLabeledTranscript || transcript;
    const title = parsed.title || `${mode.startsWith("classroom") ? "课堂记录" : "会议记录"} (${timeLabel})`;

    return { title, courseName: parsed.courseName, speakerLabeledTranscript, summary: parsed };
  } catch {
    throw new Error(`Failed to parse LLM output as JSON:\n${raw.slice(0, 200)}`);
  }
}
