import { Platform } from "react-native";
import {
  getSessionById,
  updateSessionPhase,
  updateSessionTranscript,
  updateSessionSummary,
  updateSessionEmbeddingMethod,
} from "./storage";

type ProcessingPhase = "transcribing" | "summarizing" | "indexing" | "done" | "failed";

let currentSessionId: string | null = null;
let abortFn: (() => Promise<void>) | null = null;
let listeners = new Set<() => void>();

function notify() {
  listeners.forEach((fn) => fn());
}

export function addQueueListener(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getQueueState(): { sessionId: string | null; running: boolean } {
  return { sessionId: currentSessionId, running: currentSessionId !== null };
}

export async function abortProcessing(): Promise<void> {
  if (abortFn) {
    try { await abortFn(); } catch {}
    abortFn = null;
  }
}

async function runPipeline(sessionId: string): Promise<void> {
  currentSessionId = sessionId;
  notify();

  try {
    // ── Stage 1: STT ──
    let session = await getSessionById(sessionId);
    if (!session || !session.audioUri) {
      throw new Error("Session or audio not found");
    }

    if (!session.transcript) {
      await updateSessionPhase(sessionId, "transcribing");
      notify();

      if (Platform.OS === "android") {
        const { transcribeWithWhisperAbortable, isWhisperAvailable } =
          await import("./whisper");
        if (isWhisperAvailable()) {
          const task = await transcribeWithWhisperAbortable(session.audioUri);
          abortFn = task.stop;
          const { result } = await task.promise;
          abortFn = null;
          await updateSessionTranscript(sessionId, result);
        }
      }
    }

    // ── Stage 2: LLM ──
    session = await getSessionById(sessionId);
    if (!session || !session.transcript) {
      throw new Error("No transcript available");
    }

    await updateSessionPhase(sessionId, "summarizing");
    notify();

    const { summarize } = await import("./summarization");
    const result = await summarize(
      session.transcript,
      session.mode,
      session.createdAt,
      session.endTime || new Date().toISOString(),
    );

    await updateSessionSummary(
      sessionId,
      result.summary,
      result.courseName,
      result.title,
      session.endTime,
    );

    // ── Stage 3: Vector Indexing ──
    await updateSessionPhase(sessionId, "indexing");
    notify();

    const { indexSessionSummaries } = await import("./vectorStore");
    await indexSessionSummaries(sessionId, result.summary);

    const { getLastEmbeddingMethod } = await import("./embedding");
    const embMethod = getLastEmbeddingMethod();
    if (embMethod) {
      await updateSessionEmbeddingMethod(sessionId, embMethod);
    }

    await updateSessionPhase(sessionId, "done");
    currentSessionId = null;
    abortFn = null;
    notify();
  } catch (e: any) {
    const phase: ProcessingPhase =
      e?.message?.includes("abort") || e?.message?.includes("cancel")
        ? "failed"
        : "failed";
    await updateSessionPhase(sessionId, phase, e?.message);
    currentSessionId = null;
    abortFn = null;
    notify();
  }
}

export function startProcessing(sessionId: string): void {
  if (currentSessionId === sessionId) return;

  if (currentSessionId) {
    abortProcessing().finally(() => {
      runPipeline(sessionId).catch(() => {});
    });
  } else {
    runPipeline(sessionId).catch(() => {});
  }
}

export async function resumeStuckTasks(): Promise<void> {
  if (currentSessionId) return;

  const { getAllSessions } = await import("./storage");
  const sessions = await getAllSessions();
  const stuck = sessions.find(
    (s) =>
      s.phase === "transcribing" ||
      s.phase === "summarizing" ||
      (s.phase === "recording" && s.audioUri),
  );
  if (stuck) {
    runPipeline(stuck.id).catch(() => {});
  }
}
