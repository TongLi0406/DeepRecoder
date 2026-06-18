import { requireNativeModule } from 'expo-modules-core';

export interface RecordingOptions {
  sampleRate?: number;
  fileName?: string;
  enableMetering?: boolean;
  meteringInterval?: number;
}

export interface RecordingStatus {
  isRecording: boolean;
  filePath: string | null;
  durationMs: number;
  fileSizeBytes: number;
}

interface PcmRecorderNativeModule {
  hasPermission(): boolean;
  getStatus(): RecordingStatus;
  startRecording(options: RecordingOptions): Promise<RecordingStatus>;
  stopRecording(): Promise<RecordingStatus>;
  cancelRecording(): Promise<void>;
  deleteRecording(filePath: string): Promise<boolean>;
}

const NativeModule = requireNativeModule<PcmRecorderNativeModule>('PcmRecorder');

export const PcmRecorder = {
  hasPermission: () => NativeModule.hasPermission(),
  getStatus: () => NativeModule.getStatus(),
  startRecording: (options: RecordingOptions = {}) => NativeModule.startRecording(options),
  stopRecording: () => NativeModule.stopRecording(),
  cancelRecording: () => NativeModule.cancelRecording(),
  deleteRecording: (filePath: string) => NativeModule.deleteRecording(filePath),
};

export default PcmRecorder;
