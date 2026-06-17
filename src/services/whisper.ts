import { Platform } from "react-native";

let whisperContext: any = null;

export async function initWhisper(): Promise<boolean> {
  if (Platform.OS === "web") return false;

  try {
    const whisperRn = await import("whisper.rn" as any);
    whisperContext = await whisperRn.initWhisper({ filePath: "placeholder" });
    return true;
  } catch (e: any) {
    console.warn("[Whisper] Init failed:", e?.message);
    return false;
  }
}

export async function transcribeWithWhisper(
  audioUri: string,
  language = "zh",
): Promise<string> {
  if (Platform.OS === "web") {
    throw new Error("Whisper not available on web");
  }

  if (!whisperContext) {
    const ok = await initWhisper();
    if (!ok) throw new Error("Whisper initialization failed");
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
    try {
      await whisperContext.release();
    } catch {}
    whisperContext = null;
  }
}

export function isWhisperAvailable(): boolean {
  return Platform.OS !== "web";
}
