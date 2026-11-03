export type DiarySegmentState = "pending" | "transcribing" | "done" | "failed";

export type DiarySpeakerAuto = "matched" | "unknown";

export type DiaryManualIdentity = "none" | "confirmed_self" | "confirmed_other";

export type DiaryRetentionDays = 1 | 7 | 30;

export interface DiaryNativeSegment {
  id: string;
  filePath: string;
  startTime: string;
  endTime: string;
  localDate: string;
  utcOffsetMinutes: number;
  durationMs: number;
}

export interface DiarySpeakerWindow {
  startMs: number;
  endMs: number;
  speaker: DiarySpeakerAuto;
  similarity: number | null;
}

export interface DiarySegment {
  id: string;
  filePath: string;
  startTime: string;
  endTime: string;
  localDate: string;
  utcOffsetMinutes: number;
  durationMs: number;
  state: DiarySegmentState;
  transcript: string;
  factualNotes: string;
  speakerAuto: DiarySpeakerAuto;
  speakerSimilarity: number | null;
  profileRevision: string | null;
  speakerWindows: DiarySpeakerWindow[];
  manualIdentity: DiaryManualIdentity;
  manualIdentityNote: string;
  audioDeleted: boolean;
  lastError: string;
  retryCount: number;
  updatedAt: string;
}

export interface DiaryTimelineItem {
  timeHint: string;
  event: string;
  sourceSegmentIds: string[];
}

export interface DiaryTopicItem {
  topic: string;
  details: string;
  sourceSegmentIds: string[];
}

export interface DiaryCommitmentItem {
  item: string;
  owner: string;
  due: string;
  sourceSegmentIds: string[];
}

export interface DiaryUnresolvedItem {
  item: string;
  sourceSegmentIds: string[];
}

export interface DailyDiaryContent {
  summaryNeutral: string;
  timeline: DiaryTimelineItem[];
  topics: DiaryTopicItem[];
  commitments: DiaryCommitmentItem[];
  unresolved: DiaryUnresolvedItem[];
  caveat: string;
}

export type DailyDiaryState = "dirty" | "generating" | "ready" | "failed";

export interface DailyDiary {
  localDate: string;
  version: number;
  state: DailyDiaryState;
  notes: string;
  content: DailyDiaryContent;
  sourceSegmentIds: string[];
  lastError: string;
  updatedAt: string;
}

export interface DiarySettings {
  consentGranted: boolean;
  retentionDays: DiaryRetentionDays;
}

export interface DiaryQueueStats {
  pending: number;
  transcribing: number;
  failed: number;
  done: number;
  retryableFailed: number;
}

export interface DiaryRetentionPlan {
  cutoffLocalDate: string;
  deletableSegmentIds: string[];
  blockedUnprocessedSegmentIds: string[];
}

export interface DiaryNativeStatus {
  active: boolean;
  paused: boolean;
  error: string | null;
  hasSpeakerProfile: boolean;
  modelsReady: boolean;
}

export interface DiaryRuntimeStatus {
  supported: boolean;
  platformMessage: string;
  native: DiaryNativeStatus;
  settings: DiarySettings;
  queue: DiaryQueueStats;
  processingActive: boolean;
  enrollmentActive: boolean;
}
