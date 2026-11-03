import { Platform } from "react-native";
import { File, Paths, FileMode } from "expo-file-system";
import { debugLog } from "./debug";
import { buildPcm16MonoWavHeader, parsePcm16MonoWavHeader } from "./whisper";

const SILICONFLOW_STT_URL = "https://api.siliconflow.cn/v1/audio/transcriptions";
const REMOTE_MODEL = "FunAudioLLM/SenseVoiceSmall";
const MAX_CHUNK_SECONDS = 300;
const MAX_CHUNK_BYTES = 10_000_000;
const MAX_UPLOAD_TIMEOUT_MS = 110_000;
const READ_STEP_BYTES = 256 * 1024;

async function getApiKey(): Promise<string | null> {
  try {
    const { getSiliconFlowKey } = await import("./embedding");
    return await getSiliconFlowKey();
  } catch {
    return null;
  }
}

function isRetryable(error: string): boolean {
  return /network|timeout|timed out/i.test(error);
}

function isAbortLike(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /abort/i.test(msg);
}

function makeAbortError(): Error {
  return new Error("Remote STT aborted");
}

function cleanFileUri(audioUri: string): string {
  if (audioUri.startsWith("file://") || audioUri.startsWith("blob:")) return audioUri;
  return `file://${audioUri}`;
}

function detectMimeType(nameOrUri: string): string {
  const lower = nameOrUri.toLowerCase();
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".3gp")) return "audio/3gpp";
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".wav")) return "audio/wav";
  return "application/octet-stream";
}

type ParsedNativeWav = {
  dataOffset: number;
  dataSize: number;
};

function parseNativeWav(file: File): ParsedNativeWav {
  const size = file.size ?? 0;
  if (!file.exists || size <= 44) throw new Error("Remote STT audio file is empty");
  const handle = file.open(FileMode.ReadOnly);
  try {
    const first = handle.readBytes(Math.min(size, 1024 * 1024));
    const parsed = parsePcm16MonoWavHeader(first, size);
    return { dataOffset: parsed.dataOffset, dataSize: parsed.dataSize };
  } finally {
    handle.close();
  }
}

async function getCheckpoint(scope: string, operation: string, input: string): Promise<string | null> {
  try {
    const storage = await import("./storage");
    return await storage.getProcessingCheckpoint(scope, operation, input);
  } catch {
    return null;
  }
}

async function saveCheckpoint(scope: string, operation: string, input: string, result: string): Promise<void> {
  try {
    const storage = await import("./storage");
    await storage.saveProcessingCheckpoint(scope, operation, input, result);
  } catch {
    // no-op when storage is unavailable
  }
}

async function uploadMultipartWithXhr(args: {
  key: string;
  signal?: AbortSignal;
  timeoutMs: number;
  filePart: { uri: string; name: string; type: string } | Blob;
  fileName: string;
  mimeType: string;
  model: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      reject(makeAbortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    let finished = false;

    const finalize = (fn: () => void) => {
      if (finished) return;
      finished = true;
      if (args.signal && abortListener) args.signal.removeEventListener("abort", abortListener);
      fn();
    };

    const abortListener = () => {
      try { xhr.abort(); } catch {}
    };

    xhr.open("POST", SILICONFLOW_STT_URL);
    xhr.setRequestHeader("Authorization", `Bearer ${args.key}`);
    xhr.timeout = args.timeoutMs;

    xhr.onload = () => finalize(() => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Remote STT request failed (HTTP ${xhr.status})`));
        return;
      }
      try {
        const parsed = JSON.parse(xhr.responseText || "{}");
        const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
        if (!text) {
          reject(new Error("Remote STT returned empty text"));
          return;
        }
        resolve(text);
      } catch {
        reject(new Error("Remote STT returned invalid JSON"));
      }
    });

    xhr.onerror = () => finalize(() => reject(new Error("Remote STT network error")));
    xhr.ontimeout = () => finalize(() => reject(new Error("Remote STT timed out")));
    xhr.onabort = () => finalize(() => reject(makeAbortError()));

    if (args.signal) args.signal.addEventListener("abort", abortListener, { once: true });

    const formData = new FormData();
    formData.append("model", args.model);
    if (args.filePart instanceof Blob) {
      formData.append("file", args.filePart, args.fileName);
    } else {
      formData.append("file", args.filePart as any);
    }
    xhr.send(formData);
  });
}

async function uploadOnce(args: {
  key: string;
  signal?: AbortSignal;
  filePart: { uri: string; name: string; type: string } | Blob;
  fileName: string;
  mimeType: string;
  timeoutMs: number;
}): Promise<string> {
  try {
    return await uploadMultipartWithXhr({
      ...args,
      model: REMOTE_MODEL,
    });
  } catch (error) {
    if (isAbortLike(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!isRetryable(message)) throw error;
    return uploadMultipartWithXhr({
      ...args,
      model: REMOTE_MODEL,
    });
  }
}

function getIdentityKey(file: File): string {
  const size = file.size ?? 0;
  const modified = file.lastModified ?? 0;
  return `${size}:${modified}`;
}

async function createChunkFile(args: {
  source: File;
  dataOffset: number;
  dataBytes: number;
  chunkIndex: number;
}): Promise<File> {
  const srcHandle = args.source.open(FileMode.ReadOnly);
  const tempFile = new File(Paths.cache, `remote_stt_${Date.now()}_${args.chunkIndex}.wav`);
  tempFile.create({ overwrite: true });
  const outHandle = tempFile.open(FileMode.ReadWrite);

  try {
    outHandle.offset = 0;
    outHandle.writeBytes(new Uint8Array(buildPcm16MonoWavHeader(args.dataBytes)));
    let remaining = args.dataBytes;
    let cursor = args.dataOffset;
    while (remaining > 0) {
      const step = Math.min(READ_STEP_BYTES, remaining);
      srcHandle.offset = cursor;
      const part = srcHandle.readBytes(step);
      if (part.length !== step) {
        throw new Error("Remote STT chunk read mismatch");
      }
      outHandle.writeBytes(part);
      cursor += step;
      remaining -= step;
    }
  } finally {
    try { outHandle.close(); } catch {}
    try { srcHandle.close(); } catch {}
  }

  return tempFile;
}

export async function transcribeRemote(
  audioUri: string,
  signal?: AbortSignal,
  checkpointScope?: string,
): Promise<string> {
  const key = await getApiKey();
  if (!key) {
    throw new Error("No remote STT API key configured");
  }

  const fileUri = cleanFileUri(audioUri);
  const fileName = fileUri.split("/").pop() || "audio.wav";
  const mimeType = detectMimeType(fileName);

  if (signal?.aborted) throw makeAbortError();

  if (Platform.OS === "web" || fileUri.startsWith("blob:")) {
    const blobUri = fileUri;
    if (Platform.OS !== "web") {
      throw new Error("Remote STT blob URIs are only supported on web");
    }
    const response = await fetch(blobUri);
    const blob = await response.blob();
    if (blob.size <= 0) throw new Error("Remote STT audio blob is empty");
    if (blob.size > MAX_CHUNK_BYTES) {
      throw new Error("Remote STT web upload is too large; please provide shorter PCM WAV audio");
    }
    return uploadOnce({
      key,
      signal,
      timeoutMs: MAX_UPLOAD_TIMEOUT_MS,
      filePart: blob,
      fileName,
      mimeType,
    });
  }

  const source = new File(fileUri);
  if (!source.exists || (source.size ?? 0) <= 0) {
    throw new Error("Remote STT audio file is empty or missing");
  }

  const wav = parseNativeWav(source);
  const chunks: Array<{ index: number; dataOffset: number; dataBytes: number }> = [];
  const maxBytesPerChunk = Math.min(MAX_CHUNK_BYTES, MAX_CHUNK_SECONDS * 16000 * 2);
  let remaining = wav.dataSize;
  let cursor = wav.dataOffset;
  let index = 0;
  while (remaining > 0) {
    const bytes = Math.min(maxBytesPerChunk, remaining);
    chunks.push({ index, dataOffset: cursor, dataBytes: bytes });
    cursor += bytes;
    remaining -= bytes;
    index += 1;
  }

  const identity = getIdentityKey(source);
  const scope = checkpointScope || "remote-stt";
  const op = `remote-stt-v1:${REMOTE_MODEL}`;
  const transcriptParts: string[] = [];

  for (const chunk of chunks) {
    if (signal?.aborted) throw makeAbortError();
    const ckInput = `${identity}|chunk:${chunk.index}/${chunks.length}|off:${chunk.dataOffset}|size:${chunk.dataBytes}`;
    const cached = await getCheckpoint(scope, op, ckInput);
    if (cached && cached.trim()) {
      transcriptParts.push(cached);
      continue;
    }

    let tempFile: File | null = null;
    try {
      tempFile = await createChunkFile({
        source,
        dataOffset: chunk.dataOffset,
        dataBytes: chunk.dataBytes,
        chunkIndex: chunk.index,
      });
      const text = await uploadOnce({
        key,
        signal,
        timeoutMs: MAX_UPLOAD_TIMEOUT_MS,
        filePart: {
          uri: tempFile.uri,
          name: tempFile.name,
          type: "audio/wav",
        },
        fileName: tempFile.name,
        mimeType: "audio/wav",
      });
      if (!text.trim()) throw new Error("Remote STT returned empty text");
      await saveCheckpoint(scope, op, ckInput, text);
      transcriptParts.push(text);
    } finally {
      if (tempFile) {
        try { tempFile.delete(); } catch {}
      }
    }
  }

  if (!transcriptParts.length || transcriptParts.some(x => !x.trim())) {
    throw new Error("Remote STT failed: incomplete chunk transcription");
  }

  const transcript = transcriptParts.join("\n");
  debugLog(`[RemoteSTT] Completed ${chunks.length} chunk(s), transcript chars=${transcript.length}`);
  return transcript;
}
