import { Platform } from "react-native";
import { File, Paths, FileMode } from "expo-file-system";
import { debugLog } from "./debug";

let whisperContext: any = null;
let whisperInitError: string | null = null;

const PCM_SAMPLE_RATE = 16000;
const PCM_CHANNELS = 1;
const PCM_BITS = 16;
const PCM_BYTES_PER_SEC = PCM_SAMPLE_RATE * PCM_CHANNELS * (PCM_BITS / 8);
const RIFF_HEADER_BYTES = 44;

type ParsedWav = {
  dataOffset: number;
  dataSize: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
};

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]
    | (bytes[offset + 1] << 8)
    | (bytes[offset + 2] << 16)
    | (bytes[offset + 3] << 24)
  ) >>> 0;
}

function toAscii(bytes: Uint8Array, start: number, len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) out += String.fromCharCode(bytes[start + i]);
  return out;
}

export function buildPcm16MonoWavHeader(dataByteCount: number): ArrayBuffer {
  const bytesPerSample = PCM_BITS / 8;
  const blockAlign = PCM_CHANNELS * bytesPerSample;
  const byteRate = PCM_SAMPLE_RATE * blockAlign;
  const buf = new ArrayBuffer(RIFF_HEADER_BYTES);
  const v = new DataView(buf);
  const s = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i));
  };

  s(0, "RIFF");
  v.setUint32(4, 36 + dataByteCount, true);
  s(8, "WAVE");
  s(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, PCM_CHANNELS, true);
  v.setUint32(24, PCM_SAMPLE_RATE, true);
  v.setUint32(28, byteRate, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, PCM_BITS, true);
  s(36, "data");
  v.setUint32(40, dataByteCount, true);
  return buf;
}

export function parsePcm16MonoWavHeader(headerBytes: Uint8Array, fileSize: number): ParsedWav {
  if (headerBytes.length < RIFF_HEADER_BYTES) {
    throw new Error("Invalid WAV: header too small");
  }
  if (toAscii(headerBytes, 0, 4) !== "RIFF" || toAscii(headerBytes, 8, 4) !== "WAVE") {
    throw new Error("Invalid WAV: missing RIFF/WAVE");
  }

  let cursor = 12;
  let fmtFound = false;
  let dataFound = false;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = -1;

  while (cursor + 8 <= headerBytes.length) {
    const tag = toAscii(headerBytes, cursor, 4);
    const size = readU32LE(headerBytes, cursor + 4);
    const bodyStart = cursor + 8;
    const bodyWithinLoaded = bodyStart + size <= headerBytes.length;

    if (tag === "fmt ") {
      if (!bodyWithinLoaded) throw new Error("Invalid WAV: incomplete fmt chunk");
      if (size < 16) throw new Error("Invalid WAV: fmt chunk too small");
      const audioFormat = readU16LE(headerBytes, bodyStart);
      channels = readU16LE(headerBytes, bodyStart + 2);
      sampleRate = readU32LE(headerBytes, bodyStart + 4);
      bitsPerSample = readU16LE(headerBytes, bodyStart + 14);
      if (audioFormat !== 1) throw new Error("Unsupported WAV: only PCM is supported");
      fmtFound = true;
    } else if (tag === "data") {
      dataOffset = bodyStart;
      dataSize = size;
      dataFound = true;
      break;
    }

    if (!bodyWithinLoaded) break;

    cursor = bodyStart + size + (size % 2);
  }

  if (!fmtFound || !dataFound) throw new Error("Invalid WAV: missing fmt/data chunks");
  if (sampleRate !== PCM_SAMPLE_RATE || channels !== PCM_CHANNELS || bitsPerSample !== PCM_BITS) {
    throw new Error("Unsupported WAV: expected PCM 16kHz mono 16-bit");
  }
  if (dataOffset + dataSize > fileSize) throw new Error("Invalid WAV: data chunk out of bounds");

  return { dataOffset, dataSize, sampleRate, channels, bitsPerSample };
}

function parsePcm16MonoWavFile(audioFile: File): ParsedWav {
  const fileSize = audioFile.size ?? 0;
  if (!audioFile.exists || fileSize <= RIFF_HEADER_BYTES) {
    throw new Error("Audio file is empty or unavailable");
  }

  const handle = audioFile.open(FileMode.ReadOnly);
  try {
    const readLen = Math.min(fileSize, 1024 * 1024);
    handle.offset = 0;
    const firstChunk = handle.readBytes(readLen);
    return parsePcm16MonoWavHeader(firstChunk, fileSize);
  } finally {
    handle.close();
  }
}

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
    whisperInitError = null;
    return { ok: whisperContext !== null };
  } catch (e: any) {
    whisperInitError = e?.message ?? String(e);
    return { ok: false, error: whisperInitError ?? "Whisper 初始化失败" };
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

  const parsed = parsePcm16MonoWavFile(audioFile);
  const durationSec = parsed.dataSize / PCM_BYTES_PER_SEC;
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
  let activeChunkStop: null | (() => Promise<void>) = null;

  const cleanupTempFiles = () => {
    for (const tf of tempFiles) {
      try { new File(tf).delete(); } catch {}
    }
    tempFiles.length = 0;
  };

  const promise = (async (): Promise<{ result: string }> => {
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
        const dataBytes = Math.round(chunkLen * PCM_BYTES_PER_SEC);
        const dataStart = parsed.dataOffset + Math.round(startSec * PCM_BYTES_PER_SEC);

        debugLog(`[Whisper] Segment ${i + 1}/${chunkCount} (${startSec}s–${startSec + chunkLen}s, ${(dataBytes / 1e6).toFixed(1)}MB)`);

        const header = new Uint8Array(buildPcm16MonoWavHeader(dataBytes));
        const tempFile = new File(Paths.cache, `whisper_${Date.now()}_${i}.wav`);
        tempFile.create({ overwrite: true });

        const out = tempFile.open(FileMode.ReadWrite);
        try {
          out.offset = 0;
          out.writeBytes(header);
          let remaining = dataBytes;
          let readOffset = dataStart;
          while (remaining > 0) {
            if (aborted) throw new Error("Aborted");
            const step = Math.min(256 * 1024, remaining);
            handle.offset = readOffset;
            const part = handle.readBytes(step);
            if (part.length !== step) throw new Error("Failed to read expected WAV chunk bytes");
            out.writeBytes(part);
            readOffset += step;
            remaining -= step;
          }
        } finally {
          out.close();
        }

        const tempUri = tempFile.uri;
        tempFiles.push(tempUri);
        debugLog(`[Whisper] Segment ${i + 1}: wrote temp WAV, starting transcription...`);

        if (aborted) throw new Error("Aborted");
        const chunkTask = whisperContext.transcribe(tempUri, { ...WHISPER_CHUNK_OPTS, language });
        activeChunkStop = chunkTask.stop;
        const { promise: chunkPromise } = chunkTask;
        debugLog(`[Whisper] Segment ${i + 1}: transcribe() called, awaiting promise...`);
        try {
          const { result } = await chunkPromise;
          debugLog(`[Whisper] Segment ${i + 1}: transcription done (${result ? result.length : 0} chars)`);
          if (result && !/^moog$/i.test(result.trim())) {
            results.push(result);
          }
        } finally {
          activeChunkStop = null;
          try { tempFile.delete(); } catch {}
        }
      }
    } finally {
      handle.close();
      cleanupTempFiles();
    }

    return { result: results.join("\n") };
  })();

  const stop = async () => {
    aborted = true;
    if (activeChunkStop) {
      try { await activeChunkStop(); } catch {}
    }
  };

  return { stop, promise };
}

export async function releaseWhisper(): Promise<void> {
  if (whisperContext) {
    try { await whisperContext.release(); } catch {}
    whisperContext = null;
  }
}

export function isWhisperAvailable(): boolean {
  if (Platform.OS === "web") return false;
  if (Platform.OS !== "android") return false;
  if (whisperInitError) return false;

  try {
    const bundled = new File(Paths.bundle, "models", "ggml-small.bin");
    if (bundled.exists && (bundled.size ?? 0) > 0) return true;
  } catch {}
  try {
    const direct = new File("file:///android_asset/models/ggml-small.bin");
    return direct.exists && (direct.size ?? 0) > 0;
  } catch {
    return false;
  }
}
