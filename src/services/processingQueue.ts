import {
  getSessionById,
  updateSessionPhase,
  updateSessionTranscript,
  updateSessionSummary,
  updateSessionEmbeddingMethod,
  getAllSessions,
  getProcessingCheckpoint,
  saveProcessingCheckpoint,
  updateSessionPartialSummary,
} from "./storage";
import { debugLog } from "./debug";
import { checkAbort } from "./llmContext";

type ProcessingPhase = "transcribing" | "summarizing" | "indexing" | "extracting" | "done" | "failed" | "queued";

let currentSessionId: string | null = null;
let abortFn: (() => Promise<void>) | null = null;
let controller: AbortController | null = null;
let pendingQueue: string[] = [];
let listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function addQueueListener(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getQueueState(): {
  sessionId: string | null;
  running: boolean;
  queueLength: number;
  queueIds: string[];
} {
  return {
    sessionId: currentSessionId,
    running: currentSessionId !== null,
    queueLength: pendingQueue.length,
    queueIds: [...pendingQueue],
  };
}

export async function abortProcessing(sessionId?: string): Promise<void> {
  if (sessionId) pendingQueue = pendingQueue.filter(id => id !== sessionId);
  if (sessionId && currentSessionId !== sessionId) { notify(); return; }
  controller?.abort();
  if (abortFn) {
    try { await abortFn(); } catch {}
    abortFn = null;
  }
}

async function runPipeline(sessionId: string): Promise<void> {
  currentSessionId = sessionId;
  const activeController = new AbortController();
  controller = activeController;
  const signal = activeController.signal;
  notify();

  try {
    let session = await getSessionById(sessionId);
    if (!session || session.phase === "done") return;
    checkAbort(signal);
    if (!session.transcript) {
      if (!session.audioUri) throw new Error("Audio not found; saved results retained");
      await updateSessionPhase(sessionId, "transcribing");
      notify();
      let text: string;
      try {
        const { transcribeRemote } = await import("./remoteStt");
        text = await transcribeRemote(session.audioUri, signal, sessionId);
      } catch (remoteError) {
        checkAbort(signal);
        const { transcribeWithWhisperAbortable, isWhisperAvailable } = await import("./whisper");
        if (!session.audioUri.toLowerCase().endsWith(".wav") || !isWhisperAvailable()) throw remoteError;
        const task = await transcribeWithWhisperAbortable(session.audioUri);
        abortFn = task.stop;
        if (signal.aborted) await task.stop();
        try { text = (await task.promise).result; } finally { abortFn = null; }
      }
      checkAbort(signal);
      if (!text.trim() || /^(moog)+$/i.test(text.trim())) throw new Error("No usable transcript returned");
      await updateSessionTranscript(sessionId, text);
    }
    session = await getSessionById(sessionId);
    checkAbort(signal);
    if (!session?.transcript) throw new Error("No transcript available");
    if (!session.summary) {
      await updateSessionPhase(sessionId, "summarizing");
      notify();
      const { summarize } = await import("./summarization");
      const result = await summarize(session.transcript, session.mode, session.createdAt,
        session.endTime || session.createdAt, undefined, { signal, checkpointScope: sessionId,
          onProgress: text => { updateSessionPartialSummary(sessionId, text).catch(() => {}); notify(); } });
      checkAbort(signal);
      await updateSessionSummary(sessionId, result.summary, result.courseName, result.title, session.endTime);
      await updateSessionPartialSummary(sessionId, "");
      session = await getSessionById(sessionId);
    }
    if (!session?.summary || !session.transcript) throw new Error("Saved summary unavailable");
    const summaryInput = JSON.stringify(session.summary);
    if (!await getProcessingCheckpoint(sessionId, "index-summary-v2", summaryInput)) {
      await updateSessionPhase(sessionId, "indexing");
      notify();
      const { indexSessionSummaries } = await import("./vectorStore");
      await indexSessionSummaries(sessionId, session.summary, signal);
      checkAbort(signal);
      await saveProcessingCheckpoint(sessionId, "index-summary-v2", summaryInput, "done");
      const { getLastEmbeddingMethod } = await import("./embedding");
      const method = getLastEmbeddingMethod();
      if (method) await updateSessionEmbeddingMethod(sessionId, method);
    }
    if (!await getProcessingCheckpoint(sessionId, "extract-skills-v2", session.transcript)) {
      await updateSessionPhase(sessionId, "extracting");
      notify();
      const { extractSkills } = await import("./extraction");
      await extractSkills(session.transcript, session.mode, sessionId, undefined, signal);
      checkAbort(signal);
      await saveProcessingCheckpoint(sessionId, "extract-skills-v2", session.transcript, "done");
    }
    checkAbort(signal);
    await updateSessionPhase(sessionId, "done");
  } catch (e: any) {
    debugLog(`[Pipeline] ERROR: ${e?.message || e}`);
    await updateSessionPhase(sessionId, "failed", signal.aborted
      ? "Processing cancelled; saved results retained" : e?.message || "Processing failed; saved results retained");
  } finally {
    currentSessionId = null;
    abortFn = null;
    controller = null;
    notify();
    if (pendingQueue.length > 0) {
      const nextId = pendingQueue.shift()!;
      runPipeline(nextId).catch(() => {});
    }
  }
}

export function startProcessing(sessionId: string): void {
  if (currentSessionId === sessionId) return;

  // Already in queue — skip
  if (pendingQueue.includes(sessionId)) return;

  if (currentSessionId) {
    // Busy — add to queue
    pendingQueue.push(sessionId);
    debugLog(`[Pipeline] Queued ${sessionId.slice(0, 8)} (queue: ${pendingQueue.length})`);
    notify();
  } else {
    runPipeline(sessionId).catch(() => {});
  }
}

export async function resumeStuckTasks(): Promise<void> {
  const sessions = await getAllSessions();
  const phases = new Set(["transcribing", "summarizing", "indexing", "extracting", "queued"]);
  for (const session of sessions.slice().reverse()) {
    if (phases.has(session.phase) || (session.phase === "recording" && session.audioUri)) {
      startProcessing(session.id);
    }
  }
}
