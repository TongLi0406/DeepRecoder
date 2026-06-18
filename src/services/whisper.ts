import { Platform } from "react-native";

let whisperContext: any = null;

const MODEL_URL = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin";
const MODEL_NAME = "ggml-tiny.bin";

async function ensureModel(): Promise<string> {
  if (Platform.OS === "web") throw new Error("Not supported on web");

  const { Paths, File } = await import("expo-file-system");

  // Correct: create "whisper-models" inside Paths.cache
  const modelsDir = Paths.cache.createDirectory("whisper-models");

  const modelFile = new File(modelsDir, MODEL_NAME);
  if (modelFile.exists && (modelFile.size ?? 0) > 10_000_000) {
    return modelFile.uri;
  }

  // Download from mirror
  const downloaded = await File.downloadFileAsync(MODEL_URL, modelFile, { idempotent: true });
  return downloaded.uri;
}

export async function initWhisper(): Promise<{ ok: boolean; error?: string }> {
  if (Platform.OS === "web") {
    return { ok: false, error: "Not supported on web" };
  }

  try {
    const modelPath = await ensureModel();
    const whisperRn = await import("whisper.rn" as any);
    whisperContext = await whisperRn.initWhisper({ filePath: modelPath });
    return { ok: whisperContext !== null };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export async function transcribeWithWhisper(
  audioUri: string,
  language = "zh",
): Promise<string> {
  if (Platform.OS === "web") {
    throw new Error("Whisper not available on web");
  }

  // Verify audio file exists and has content
  const fileUri = audioUri.startsWith("file://") ? audioUri : `file://${audioUri}`;
  const { File } = await import("expo-file-system");
  const audioFile = new File(fileUri);
  if (!audioFile.exists) {
    throw new Error(`Audio file not found: ${fileUri}`);
  }
  if ((audioFile.size ?? 0) < 1000) {
    throw new Error(`Audio file too small (${audioFile.size} bytes) - recording may have failed`);
  }

  if (!whisperContext) {
    const result = await initWhisper();
    if (!result.ok) throw new Error(`Whisper init failed: ${result.error}`);
  }

  const { promise } = whisperContext.transcribe(audioUri, {
    language,
    maxLen: 1,
    printProgress: false,
    printRealtime: false,
    printTimestamps: false,
  });

  const { result } = await promise;
  return result;
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
