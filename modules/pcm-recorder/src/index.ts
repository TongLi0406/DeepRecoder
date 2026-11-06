import { requireNativeModule } from 'expo-modules-core';

export interface RecordingOptions {
  sampleRate?: number;
  fileName?: string;
  enableMetering?: boolean;
  meteringInterval?: number;
}

export interface RecordingStatus {
  isRecording: boolean;
  isPaused?: boolean;
  filePath: string | null;
  durationMs: number;
  fileSizeBytes: number;
}

export interface DiaryNativeSegment {
  id: string;
  filePath: string;
  startTime: string;
  endTime: string;
  localDate: string;
  utcOffsetMinutes: number;
  durationMs: number;
}

export interface DiaryNativeStatus {
  active: boolean;
  paused: boolean;
  error: string | null;
  hasSpeakerProfile: boolean;
  modelsReady: boolean;
}

export interface SpeakerEvidenceWindow {
  startMs: number;
  endMs: number;
  speaker: 'matched' | 'unknown';
  similarity: number | null;
}

export interface SpeakerEvidence {
  speaker: 'matched' | 'unknown';
  similarity: number | null;
  profileRevision: string | null;
  windows: SpeakerEvidenceWindow[];
}

export interface HttpResponse {
  status: number;
  body: string;
}

interface PcmRecorderNativeModule {
  hasPermission(): boolean;
  getStatus(): RecordingStatus;
  startRecording(options: RecordingOptions): Promise<RecordingStatus>;
  stopRecording(): Promise<RecordingStatus>;
  pauseRecording(): Promise<RecordingStatus>;
  resumeRecording(): Promise<RecordingStatus>;
  cancelRecording(): Promise<void>;
  deleteRecording(filePath: string): Promise<boolean>;

  getDiaryStatus(): Promise<DiaryNativeStatus>;
  prepareDiaryModels(): Promise<void>;
  startDiary(): Promise<void>;
  stopDiary(): Promise<void>;
  pauseDiary(): Promise<void>;
  resumeDiary(): Promise<void>;
  listDiarySegments(): Promise<DiaryNativeSegment[]>;
  listDiarySegmentsPage(offset: number, limit: number): Promise<DiaryNativeSegment[]>;
  deleteDiarySegment(id: string): Promise<void>;

  identifySpeaker(filePath: string): Promise<SpeakerEvidence>;
  enrollSpeaker(filePath: string): Promise<void>;
  deleteSpeakerProfile(): Promise<void>;

  httpPostJson(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<HttpResponse>;
  httpPostMultipart(url: string, headers: Record<string, string>, fields: Record<string, string>,
    filePath: string, fileName: string, mimeType: string, timeoutMs: number): Promise<HttpResponse>;

  addListener(eventName: string, listener: (...args: any[]) => void): { remove: () => void };
}

const NativeModule = requireNativeModule<PcmRecorderNativeModule>('PcmRecorder');

export const PcmRecorder = {
  hasPermission: () => NativeModule.hasPermission(),
  getStatus: () => NativeModule.getStatus(),
  startRecording: (options: RecordingOptions = {}) => NativeModule.startRecording(options),
  stopRecording: () => NativeModule.stopRecording(),
  pauseRecording: () => NativeModule.pauseRecording(),
  resumeRecording: () => NativeModule.resumeRecording(),
  cancelRecording: () => NativeModule.cancelRecording(),
  deleteRecording: (filePath: string) => NativeModule.deleteRecording(filePath),

  getDiaryStatus: () => NativeModule.getDiaryStatus(),
  prepareDiaryModels: () => NativeModule.prepareDiaryModels(),
  startDiary: () => NativeModule.startDiary(),
  stopDiary: () => NativeModule.stopDiary(),
  pauseDiary: () => NativeModule.pauseDiary(),
  resumeDiary: () => NativeModule.resumeDiary(),
  listDiarySegments: () => NativeModule.listDiarySegments(),
  listDiarySegmentsPage: (offset: number, limit: number) => NativeModule.listDiarySegmentsPage(offset, limit),
  deleteDiarySegment: (id: string) => NativeModule.deleteDiarySegment(id),

  identifySpeaker: (filePath: string) => NativeModule.identifySpeaker(filePath),
  enrollSpeaker: (filePath: string) => NativeModule.enrollSpeaker(filePath),
  deleteSpeakerProfile: () => NativeModule.deleteSpeakerProfile(),

  httpPostJson: (url: string, headers: Record<string, string>, body: string, timeoutMs = 30000) =>
    NativeModule.httpPostJson(url, headers, body, timeoutMs),
  httpPostMultipart: (url: string, headers: Record<string, string>, fields: Record<string, string>,
    filePath: string, fileName: string, mimeType: string, timeoutMs = 110000) =>
    NativeModule.httpPostMultipart(url, headers, fields, filePath, fileName, mimeType, timeoutMs),

  addListener: (eventName: string, listener: (...args: any[]) => void) => NativeModule.addListener(eventName, listener),
};

export default PcmRecorder;
