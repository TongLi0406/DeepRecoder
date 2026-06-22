// ─── Session Types ───

export type SessionMode = "meeting-organizer" | "meeting-attendee" | "classroom-student" | "classroom-teacher";

export type SessionPhase = "recording" | "transcribing" | "summarizing" | "indexing" | "extracting" | "done" | "failed" | "queued";

export interface KnowledgePoint {
  id: string;
  name: string;
  description: string;
  category: string;
  masteryHint?: string;
}

export interface ProblemApproach {
  id: string;
  approach: string;
  usedFor: string[];
  procedure: string;
}

export interface InterLessonConnection {
  id: string;
  connection: string;
  description: string;
  relatedTopic: string;
}

// ─── Student Mode Output ───

export interface StudentSummary {
  courseName: string;
  topic: string;
  knowledgePoints: KnowledgePoint[];
  problemSolvingApproaches: ProblemApproach[];
  interLessonConnections: InterLessonConnection[];
}

// ─── Teacher Mode Output ───

export interface TeachingStructureSection {
  section: string;
  description: string;
  durationHint: string;
}

export interface QuestionType {
  type: string;
  count: number;
  examples: string[];
  quality: string;
}

export interface StudentEngagement {
  pattern: string;
  highlights: string[];
  concerns: string[];
}

export interface TeacherSummary extends StudentSummary {
  teachingStyle: string;
  interactionLevel: string;
  teachingStructure: TeachingStructureSection[];
  questionTypes: QuestionType[];
  studentEngagement: StudentEngagement;
  improvementSuggestions: string[];
}

// ─── Meeting Mode Output ───

export interface Decision {
  id: string;
  content: string;
  context: string;
}

export interface ActionItem {
  id: string;
  content: string;
  assignee: string;
  deadline?: string;
}

export interface MeetingSummary {
  title: string;
  date: string;
  attendees: string[];
  decisions: Decision[];
  actionItems: ActionItem[];
  problems: string[];
  goals: string[];
  keyPoints: string[];
}

// ─── Session ───

export interface Session {
  id: string;
  createdAt: string;
  endTime?: string;
  title?: string;
  mode: SessionMode;
  phase: SessionPhase;
  audioUri: string;
  audioDuration: number;
  transcript?: string;
  summary?: StudentSummary | TeacherSummary | MeetingSummary;
  courseName?: string;
  embeddingMethod?: string;
  error?: string;
}

// ─── API Key ───

export interface ApiKeyStatus {
  configured: boolean;
  valid: boolean;
  testing: boolean;
  error?: string;
}

// ─── Skills ───

export type SkillCategory =
  // Classroom-Student
  | "problem_solving" | "learning_strategy" | "knowledge_connection"
  // Classroom-Teacher
  | "teaching_strategy" | "engagement_technique" | "question_design" | "assessment"
  // Meeting-Organizer
  | "decision_framework" | "meeting_process" | "problem_identification"
  // Meeting-Attendee
  | "action_tracking" | "communication_insight" | "personal_productivity"
  // Legacy / fallback
  | "teaching_method" | "meeting_practice" | "decision_pattern" | "communication" | "other";

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: SkillCategory;
  sourceSessionIds: string[];
  mergedFrom: string[];
  mergedInto?: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConsolidationCandidate {
  skillA: Skill;
  skillB: Skill;
  similarity: number;
}

export interface ConsolidationResult {
  merged: { parent: string; child: string }[];
  skipped: { skillA: string; skillB: string; reason: string }[];
}
