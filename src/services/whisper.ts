import { Platform } from "react-native";
import { File, Paths, FileMode } from "expo-file-system";
import { debugLog } from "./debug";

let whisperContext: any = null;

async function ensureModel(): Promise<string> {
  if (Platform.OS === "web") throw new Error("Not supported on web");

  if (Platform.OS === "android") {
    // Model placed directly in android/app/src/main/assets/models/
    // Bypasses Metro bundle size limit (~512MB cap)
    return "file:///android_asset/models/ggml-small.bin";
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

const WHISPER_OPTS = {
  language: "zh",
  maxLen: 0,
  maxThreads: 8,
  beamSize: 5,
  bestOf: 5,
  temperature: 0,
};

// Reduced settings for chunked mode — 5× bestOf with 19 chunks would take hours
const WHISPER_CHUNK_OPTS = {
  language: "zh",
  maxLen: 0,
  maxThreads: 8,
  beamSize: 3,
  bestOf: 1,
  temperature: 0,
};

const CHUNK_SEC = 300; // 5 min, ~9.6MB per segment — fewer chunks, faster overall
const MAX_DIRECT_SEC = CHUNK_SEC + 60;

function buildWavHeader(dataByteCount: number): ArrayBuffer {
  const sampleRate = 16000;
  const bytesPerSample = 2;
  const channels = 1;
  const bytesPerSec = sampleRate * bytesPerSample * channels;
  const total = 44 + dataByteCount;
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  const s = (off: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
  s(0, "RIFF"); v.setUint32(4, total - 8, true);
  s(8, "WAVE"); s(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true);
  v.setUint32(28, bytesPerSec, true); v.setUint16(32, bytesPerSample * channels, true);
  v.setUint16(34, bytesPerSample * 8, true);
  s(36, "data"); v.setUint32(40, dataByteCount, true);
  return buf;
}

function wavBytesToDurationSec(fileSizeBytes: number): number {
  return (fileSizeBytes - 44) / (16000 * 2);
}

export async function transcribeWithWhisperAbortable(
  audioUri: string,
  language = "zh",
): Promise<{ stop: () => Promise<void>; promise: Promise<{ result: string }> }> {
  if (Platform.OS === "web") throw new Error("Whisper not available on web");

  const fileUri = audioUri.startsWith("file://") ? audioUri : `file://${audioUri}`;
  const audioFile = new File(fileUri);
  if (!audioFile.exists) throw new Error(`Audio file not found: ${fileUri}`);
  const fileSize = audioFile.size ?? 0;
  if (fileSize < 1000) throw new Error(`Audio file too small (${fileSize} bytes)`);

  const lower = fileUri.toLowerCase();
  if (!lower.endsWith(".wav") && !lower.endsWith(".pcm")) {
    if (lower.endsWith(".m4a") || lower.endsWith(".mp4") || lower.endsWith(".3gp")) {
      throw new Error("Compressed audio format (M4A/MP4). PcmRecorder was not used — please re-record.");
    }
    throw new Error("Unsupported audio format. Only 16-bit PCM WAV supported.");
  }

  if (!whisperContext) {
    const r = await initWhisper();
    if (!r.ok) throw new Error(`Whisper init failed: ${r.error}`);
  }

  const durationSec = wavBytesToDurationSec(fileSize);
  const durationMin = Math.round(durationSec / 60);
  const sizeMB = (fileSize / 1e6).toFixed(1);
  debugLog(`[Whisper] ${durationMin}min WAV (${sizeMB}MB)`);

  if (durationSec <= MAX_DIRECT_SEC) {
    return whisperContext.transcribe(audioUri, WHISPER_OPTS);
  }

  // ── Long audio: chunked transcription ──
  debugLog(`[Whisper] Chunking into ${Math.ceil(durationSec / CHUNK_SEC)} segments`);
  let aborted = false;
  const tempFiles: string[] = [];

  const promise = (async (): Promise<{ result: string }> => {
    const bytesPerSec = 16000 * 2;
    const results: string[] = [];
    const chunkCount = Math.ceil(durationSec / CHUNK_SEC);

    // Open source WAV via FileHandle for offset-based reading — avoids loading entire file
    debugLog(`[Whisper] Opening file handle for chunked read...`);
    const handle = audioFile.open(FileMode.ReadOnly);
    debugLog(`[Whisper] FileHandle opened, starting ${chunkCount} chunks...`);
    try {
      for (let i = 0; i < chunkCount; i++) {
        if (aborted) throw new Error("Aborted");
        const startSec = i * CHUNK_SEC;
        const chunkLen = Math.min(CHUNK_SEC, durationSec - startSec);
        const dataBytes = chunkLen * bytesPerSec;
        const dataStart = 44 + startSec * bytesPerSec;

        debugLog(`[Whisper] Segment ${i + 1}/${chunkCount} (${startSec}s–${startSec + chunkLen}s, ${(dataBytes / 1e6).toFixed(1)}MB)`);

        // Seek to chunk offset and read raw PCM bytes directly — no base64, no OOM
        handle.offset = dataStart;
        const chunkData = handle.readBytes(dataBytes);
        debugLog(`[Whisper] Segment ${i + 1}: read ${(chunkData.length / 1e6).toFixed(1)}MB, building WAV...`);

        // Build chunk WAV: header + raw audio
        const header = new Uint8Array(buildWavHeader(dataBytes));
        const chunk = new Uint8Array(44 + dataBytes);
        chunk.set(header, 0);
        chunk.set(chunkData, 44);

        // Write temp WAV via new File API
        const tempFile = new File(Paths.cache, `whisper_${Date.now()}_${i}.wav`);
        tempFile.create({ overwrite: true });
        tempFile.write(chunk);
        const tempUri = tempFile.uri;
        tempFiles.push(tempUri);
        debugLog(`[Whisper] Segment ${i + 1}: wrote temp WAV, starting transcription...`);

        if (aborted) throw new Error("Aborted");
        const { promise: chunkPromise } = whisperContext.transcribe(tempUri, WHISPER_CHUNK_OPTS);
        debugLog(`[Whisper] Segment ${i + 1}: transcribe() called, awaiting promise...`);
        const { result } = await chunkPromise;
        debugLog(`[Whisper] Segment ${i + 1}: transcription done (${result ? result.length : 0} chars)`);
        if (result && !/^moog$/i.test(result.trim())) {
          results.push(result);
        }
      }
    } finally {
      handle.close();
    }

    return { result: results.join("\n") };
  })();

  const stop = async () => {
    aborted = true;
    for (const tf of tempFiles) { try { new File(tf).delete(); } catch {} }
  };
  promise.then(() => {
    for (const tf of tempFiles) { try { new File(tf).delete(); } catch {} }
  }).catch(() => {});

  return { stop, promise };
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
