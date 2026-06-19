import { Platform } from "react-native";

let whisperContext: any = null;

async function ensureModel(): Promise<string> {
  if (Platform.OS === "web") throw new Error("Not supported on web");

  if (Platform.OS === "android") {
    // Model placed directly in android/app/src/main/assets/models/
    // Bypasses Metro bundle size limit (~512MB cap)
    return "file:///android_asset/models/ggml-medium.bin";
  }

  // iOS: use expo-asset (TBD)
  throw new Error("iOS not yet supported");
}

export async function initWhisper(): Promise<{ ok: boolean; error?: string }> {
  if (Platform.OS === "web") {
    return { ok: false, error: "Not supported on web" };
  }

  try {
    const modelPath = await ensureModel();
    const whisperRn = await import("whisper.rn" as any);
    whisperContext = await whisperRn.initWhisper({
      filePath: modelPath,
      isBundleAsset: Platform.OS === "android",
    });
    return { ok: whisperContext !== null };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function transcribeWithWhisper(
  audioUri: string,
  language = "zh",
): Promise<string> {
  const { promise } = await transcribeWithWhisperAbortable(audioUri, language);
  const { result } = await promise;
  return result;
}

export async function transcribeWithWhisperAbortable(
  audioUri: string,
  language = "zh",
): Promise<{ stop: () => Promise<void>; promise: Promise<{ result: string }> }> {
  if (Platform.OS === "web") {
    throw new Error("Whisper not available on web");
  }

  const fileUri = audioUri.startsWith("file://") ? audioUri : `file://${audioUri}`;
  const { File } = await import("expo-file-system");
  const audioFile = new File(fileUri);
  if (!audioFile.exists) {
    throw new Error(`Audio file not found: ${fileUri}`);
  }
  if ((audioFile.size ?? 0) < 1000) {
    throw new Error(`Audio file too small (${audioFile.size} bytes) - recording may have failed`);
  }

  const lower = fileUri.toLowerCase();
  if (!lower.endsWith(".wav") && !lower.endsWith(".pcm")) {
    if (lower.endsWith(".m4a") || lower.endsWith(".mp4") || lower.endsWith(".3gp")) {
      throw new Error(
        "Compressed audio format detected (M4A/MP4). Transcription requires uncompressed WAV. " +
        "PcmRecorder was not used for this recording — please re-record."
      );
    }
    throw new Error("Unsupported audio format. Only 16-bit PCM WAV files are supported by whisper.");
  }

  if (!whisperContext) {
    const result = await initWhisper();
    if (!result.ok) throw new Error(`Whisper init failed: ${result.error}`);
  }

  return whisperContext.transcribe(audioUri, {
    language: "zh",
    maxLen: 0,
    beamSize: 8,
    bestOf: 8,
    temperature: 0,
  });
}

export async function releaseWhisper(): Promise<void> {
  if (whisperContext) {
    try { await whisperContext.release(); } catch {}
    whisperContext = null;
  }
}

export function isWhisperAvailable(): boolean {
  return Platform.OS !== "web";
}
