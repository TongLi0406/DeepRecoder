import { Platform } from "react-native";
import { callLLM, getModelConfig } from "./api";
import { compactTranscript } from "./summarization";
import { compactText, textBytes, checkAbort } from "./llmContext";
import { startRecording, stopRecording, cleanupRecording, isRecordingActive, deleteFile } from "./recording";
import { transcribeRemote } from "./remoteStt";
import {
  clearAutoSpeakerEvidence,
  clearAllDiaryData,
  deleteSegment,
  deleteSegmentsByIds,
  getDailyDiary,
  getDiaryQueueStats,
  getDiarySegment,
  getDiarySettings,
  importNativeDiarySegments,
  initDiaryStorage,
  listDailyDiaryEntries,
  listAllDiarySegments,
  listDiarySegmentsByDate,
  listPendingDiarySegments,
  markDailyDiaryFailed,
  markDayDirty,
  markSegmentResult,
  markSegmentAudioDeleted,
  markSegmentsAudioDeleted,
  markSegmentState,
  planRetentionCleanup,
  recoverDiaryStaleStates,
  saveDailyDiary,
  saveDailyDiaryDraft,
  setDiaryConsent,
  setDiaryRetentionDays,
  setManualSegmentIdentity,
} from "./diaryStorage";
import { deleteProcessingCheckpoints } from "./storage";
import type {
  DailyDiary,
  DailyDiaryContent,
  DiaryManualIdentity,
  DiaryNativeSegment,
  DiaryNativeStatus,
  DiaryRetentionDays,
  DiaryRuntimeStatus,
  DiarySegment,
  DiarySpeakerAuto,
  DiarySpeakerWindow,
} from "../types/diary";

type NativeModule = {
  hasPermission?(): boolean;
  getDiaryStatus(): Promise<DiaryNativeStatus>;
  prepareDiaryModels(): Promise<void>;
  startDiary(): Promise<void>;
  stopDiary(): Promise<void>;
  pauseDiary(): Promise<void>;
  resumeDiary(): Promise<void>;
  listDiarySegments(): Promise<DiaryNativeSegment[]>;
  deleteDiarySegment(id: string): Promise<void>;
  identifySpeaker(path: string): Promise<{ speaker: "matched" | "unknown"; similarity: number | null; profileRevision: string | null; windows: DiarySpeakerWindow[] }>;
  enrollSpeaker(path: string): Promise<void>;
  deleteSpeakerProfile(): Promise<void>;
};

const REDUCE_SYSTEM = `Compress diary segment notes while preserving source labels [[SRC:segment-id]].
Keep only neutral facts, timeline markers, decisions, commitments and unresolved issues.
Never invent identity or first-person ownership.
Do not remove or rewrite source labels.`;

const DAILY_SYSTEM = `Generate a daily diary JSON from bounded notes.
Rules:
1) Unknown or mixed identity must stay neutral.
2) sourceSegmentIds must only include IDs present in input source labels [[SRC:segment-id]].
3) Do not claim citations are proof.
4) If evidence is insufficient, use empty arrays.
5) Every non-empty timeline/topic/commitment/unresolved item must include at least one sourceSegmentIds entry.
6) Never invent source IDs.

Return strict JSON with:
{
  "summaryNeutral": "...",
  "timeline": [{"timeHint":"", "event":"", "sourceSegmentIds":["S1"]}],
  "topics": [{"topic":"", "details":"", "sourceSegmentIds":["S1"]}],
  "commitments": [{"item":"", "owner":"", "due":"", "sourceSegmentIds":["S1"]}],
  "unresolved": [{"item":"", "sourceSegmentIds":["S1"]}],
  "caveat": "Sources are references, not proof."
}`;

let processingActive = false;
let processingAbort: AbortController | null = null;
let enrollmentActive = false;
let processingPromise: Promise<{ processed: number; failed: number; skipped: boolean }> | null = null;
const generatingControllers = new Map<string, AbortController>();
const generatingPromises = new Map<string, Promise<DailyDiary>>();
let lifecycleEpoch = 0;
let lifecycleMutation: Promise<void> = Promise.resolve();
let lifecycleMutationReason = "";

function makeAbortError(message = "Diary operation canceled"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    return /abort|revoked|lifecycle changed/i.test(error.message);
  }
  return /abort|revoked|lifecycle changed/i.test(String(error ?? ""));
}

function hasConsent(settings: { consentGranted: boolean }): boolean {
  return settings.consentGranted;
}

async function checkConsentOrThrow(context: string): Promise<void> {
  const settings = await getDiarySettings();
  if (!hasConsent(settings)) {
    throw makeAbortError(`Diary consent revoked during ${context}`);
  }
}

function checkLifecycleOrThrow(startEpoch: number, context: string): void {
  if (startEpoch !== lifecycleEpoch) {
    throw makeAbortError(`Diary lifecycle changed during ${context}`);
  }
}

async function waitForLifecycleMutation(): Promise<void> {
  await lifecycleMutation;
}

async function withLifecycleMutation<T>(reason: string, operation: () => Promise<T>): Promise<T> {
  const prev = lifecycleMutation;
  let release = () => {};
  lifecycleMutation = new Promise<void>(resolve => {
    release = resolve;
  });
  await prev;
  lifecycleMutationReason = reason;
  lifecycleEpoch += 1;
  try {
    return await operation();
  } finally {
    lifecycleMutationReason = "";
    release();
  }
}

async function assertLifecycleOpen(context: string): Promise<number> {
  await waitForLifecycleMutation();
  if (lifecycleMutationReason) {
    throw new Error(`Diary operation blocked while ${lifecycleMutationReason}`);
  }
  return lifecycleEpoch;
}

function segmentTranscriptScope(id: string): string {
  return `diary:segment:${id}`;
}

function segmentNotesScope(id: string): string {
  return `diary:notes:${id}`;
}

async function clearSegmentCheckpoints(id: string, clearLegacy = false): Promise<void> {
  await deleteProcessingCheckpoints(segmentTranscriptScope(id));
  await deleteProcessingCheckpoints(segmentNotesScope(id));
  if (clearLegacy) {
    await deleteProcessingCheckpoints("remote-stt");
  }
}

function registerGeneration(localDate: string, controller: AbortController, promise: Promise<DailyDiary>): void {
  generatingControllers.set(localDate, controller);
  generatingPromises.set(localDate, promise);
}

function unregisterGeneration(localDate: string): void {
  generatingControllers.delete(localDate);
  generatingPromises.delete(localDate);
}

async function waitForDiaryIdle(): Promise<void> {
  if (processingPromise) {
    await processingPromise.catch(() => {});
  }
  const pending = Array.from(generatingPromises.values());
  if (pending.length) {
    await Promise.allSettled(pending);
  }
}

async function cancelAndDrainDiaryWorkers(): Promise<void> {
  processingAbort?.abort();
  for (const controller of generatingControllers.values()) {
    controller.abort();
  }
  await waitForDiaryIdle();
}

function createLinkedAbortSignal(external?: AbortSignal): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (!external) {
    return { controller, signal: controller.signal, dispose: () => {} };
  }
  if (external.aborted) {
    controller.abort();
    return { controller, signal: controller.signal, dispose: () => {} };
  }
  const abort = () => controller.abort();
  external.addEventListener("abort", abort, { once: true });
  return {
    controller,
    signal: controller.signal,
    dispose: () => external.removeEventListener("abort", abort),
  };
}

function isSupportedPlatform(): boolean {
  return Platform.OS === "android";
}

function platformMessage(): string {
  if (Platform.OS === "android") return "Diary capture is available on Android.";
  if (Platform.OS === "ios") return "Diary capture is not available on iOS in this build.";
  return "Diary capture is Android-only. Web cannot simulate background capture.";
}

async function getNative(): Promise<NativeModule | null> {
  if (!isSupportedPlatform()) return null;
  const module = await import("../../modules/pcm-recorder/src");
  return module.PcmRecorder as NativeModule;
}

async function ensureDiaryMicPermission(native: NativeModule | null): Promise<void> {
  if (!isSupportedPlatform()) return;
  if (native?.hasPermission?.()) return;
  const audio = await import("expo-audio");
  const current = await audio.getRecordingPermissionsAsync();
  if (!current?.granted) {
    const requested = await audio.requestRecordingPermissionsAsync();
    if (!requested?.granted) {
      throw new Error("Microphone permission denied");
    }
  }
  if (native?.hasPermission && !native.hasPermission()) {
    throw new Error("Microphone permission denied");
  }
}

function safeParseJson(raw: string): any {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return JSON.parse(fence[1].trim());
  return JSON.parse(text);
}

function flattenSourceIds(content: DailyDiaryContent): string[] {
  const ids: string[] = [];
  for (const row of content.timeline) ids.push(...row.sourceSegmentIds);
  for (const row of content.topics) ids.push(...row.sourceSegmentIds);
  for (const row of content.commitments) ids.push(...row.sourceSegmentIds);
  for (const row of content.unresolved) ids.push(...row.sourceSegmentIds);
  return Array.from(new Set(ids));
}

const SOURCE_MARKER_RE = /\[\[SRC:([A-Za-z0-9._-]+)\]\]/g;
const FIRST_PERSON_RE = /\b(i|i'm|i've|i'd|me|my|mine|myself|we|we're|we've|we'd|our|ours|ourselves|us)\b|我|我们/i;

type DiaryBudgets = {
  notesBudget: number;
  reduceOutputTokens: number;
  finalOutputTokens: number;
  finalUserPrefix: string;
};

function sanitizeForMarkers(text: string): string {
  return text.replace(/\[\[SRC:/g, "[[USR_SRC:");
}

function assertNoObviousFirstPerson(text: string, context: string): void {
  if (!text.trim()) return;
  if (FIRST_PERSON_RE.test(text)) {
    throw new Error(`${context} contains first-person ownership terms for unconfirmed attribution. Automated checks only detect obvious terms and cannot prove speaker ownership.`);
  }
}

function assertSourceSubsetOrThrow(output: string, allowedSourceIds: string[], context: string): string[] {
  const allowed = new Set(allowedSourceIds);
  const retained = extractSourceMarkers(output);
  if (output.trim() && allowed.size > 0 && retained.length === 0) {
    throw new Error(`${context} produced source-bearing output without [[SRC:*]] markers`);
  }
  for (const sourceId of retained) {
    if (!allowed.has(sourceId)) {
      throw new Error(`${context} emitted out-of-scope source marker: ${sourceId}`);
    }
  }
  return retained;
}

function buildDiaryBudgets(localDate: string, contextLimit: number): DiaryBudgets {
  const finalOutputTokens = 1536;
  const finalUserPrefix = `Local date: ${localDate}\nSummarize strictly from notes with [[SRC:*]] evidence.\n\n`;
  const protocolReserve = 1024;
  const available = contextLimit - textBytes(DAILY_SYSTEM) - textBytes(finalUserPrefix) - finalOutputTokens - protocolReserve;
  const notesBudget = Math.max(128, Math.floor(available));
  if (notesBudget < 128 || contextLimit < 8192) {
    throw new Error(`Model context ${contextLimit} is insufficient for minimum diary generation budget`);
  }
  const reduceOutputTokens = Math.max(128, Math.min(1024, Math.floor(notesBudget / 4)));
  return {
    notesBudget,
    reduceOutputTokens,
    finalOutputTokens,
    finalUserPrefix,
  };
}

function packSourceBlocks(blocks: Array<{ text: string; sourceIds: string[] }>, maxBytes: number): Array<{ text: string; sourceIds: string[] }> {
  const packed: Array<{ text: string; sourceIds: string[] }> = [];
  let currentBlocks: string[] = [];
  let currentIds = new Set<string>();
  let currentBytes = 0;

  for (const block of blocks) {
    const separator = currentBlocks.length ? "\n\n" : "";
    const addBytes = textBytes(separator + block.text);
    if (currentBlocks.length > 0 && currentBytes + addBytes > maxBytes) {
      packed.push({ text: currentBlocks.join("\n\n"), sourceIds: Array.from(currentIds) });
      currentBlocks = [];
      currentIds = new Set<string>();
      currentBytes = 0;
    }
    currentBlocks.push(block.text);
    block.sourceIds.forEach(id => currentIds.add(id));
    currentBytes += textBytes(currentBlocks.length > 1 ? `\n\n${block.text}` : block.text);
  }

  if (currentBlocks.length > 0) {
    packed.push({ text: currentBlocks.join("\n\n"), sourceIds: Array.from(currentIds) });
  }

  return packed;
}

function extractSourceMarkers(text: string): string[] {
  const ids: string[] = [];
  SOURCE_MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null = SOURCE_MARKER_RE.exec(text);
  while (match) {
    ids.push(match[1]);
    match = SOURCE_MARKER_RE.exec(text);
  }
  return Array.from(new Set(ids));
}

function normalizeContent(content: any): DailyDiaryContent {
  const asArray = (value: any): any[] => (Array.isArray(value) ? value : []);
  return {
    summaryNeutral: typeof content?.summaryNeutral === "string" ? content.summaryNeutral : "",
    timeline: asArray(content?.timeline).map(item => ({
      timeHint: typeof item?.timeHint === "string" ? item.timeHint : "",
      event: typeof item?.event === "string" ? item.event : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    topics: asArray(content?.topics).map(item => ({
      topic: typeof item?.topic === "string" ? item.topic : "",
      details: typeof item?.details === "string" ? item.details : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    commitments: asArray(content?.commitments).map(item => ({
      item: typeof item?.item === "string" ? item.item : "",
      owner: typeof item?.owner === "string" ? item.owner : "",
      due: typeof item?.due === "string" ? item.due : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    unresolved: asArray(content?.unresolved).map(item => ({
      item: typeof item?.item === "string" ? item.item : "",
      sourceSegmentIds: asArray(item?.sourceSegmentIds).filter((x: any) => typeof x === "string"),
    })),
    caveat: "Sources are references, not proof.",
  };
}

function segmentIdentityTag(segment: DiarySegment): string {
  if (segment.manualIdentity === "confirmed_self") return "manual=self";
  if (segment.manualIdentity === "confirmed_other") return "manual=other";
  if (segment.speakerAuto === "matched") return "auto=matched-probabilistic";
  return "auto=unknown";
}

async function getNativeStatusOrDefault(): Promise<DiaryNativeStatus> {
  const native = await getNative();
  if (!native) {
    return {
      active: false,
      paused: false,
      error: null,
      hasSpeakerProfile: false,
      modelsReady: false,
    };
  }
  try {
    return await native.getDiaryStatus();
  } catch (error: any) {
    return {
      active: false,
      paused: false,
      error: error?.message ?? "Diary status unavailable",
      hasSpeakerProfile: false,
      modelsReady: false,
    };
  }
}

async function stopCaptureAndWaitInactive(): Promise<void> {
  const checks = [80, 160, 320, 500, 800];
  for (const delayMs of checks) {
    const status = await getNativeStatusOrDefault();
    if (!status.active) return;
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

async function reduceSingleSourceBlock(
  sourceId: string,
  identityTag: string,
  text: string,
  notesBudget: number,
  reduceOutputTokens: number,
  signal?: AbortSignal,
): Promise<{ text: string; sourceIds: string[] }> {
  const body = sanitizeForMarkers(text.trim());
  if (!body) {
    return { text: `[[SRC:${sourceId}]] [${identityTag}]`, sourceIds: [sourceId] };
  }

  if (textBytes(`[[SRC:${sourceId}]] [${identityTag}]\n${body}`) <= notesBudget) {
    return { text: `[[SRC:${sourceId}]] [${identityTag}]\n${body}`, sourceIds: [sourceId] };
  }

  const reducedBody = await compactText(
    body,
    async chunk => {
      checkAbort(signal);
      const next = await callLLM(REDUCE_SYSTEM, chunk, undefined, reduceOutputTokens, true, { signal, timeoutMs: 60000 });
      if (!next.trim() || textBytes(next) > notesBudget) {
        throw new Error(`Single-source reduction output invalid for ${sourceId}`);
      }
      return next;
    },
    notesBudget,
    signal,
  );

  return { text: `[[SRC:${sourceId}]] [${identityTag}]\n${sanitizeForMarkers(reducedBody.trim())}`, sourceIds: [sourceId] };
}

async function buildBoundedDayNotes(localDate: string, segments: DiarySegment[], budgets: DiaryBudgets, signal?: AbortSignal): Promise<string> {
  const sourceBlocks = segments
    .filter(item => item.state === "done" && item.factualNotes.trim())
    .map(item => ({
      id: item.id,
      identityTag: segmentIdentityTag(item),
      text: item.factualNotes.trim(),
    }));

  if (!sourceBlocks.length) return "";

  const normalizedBlocks: Array<{ text: string; sourceIds: string[] }> = [];
  for (const block of sourceBlocks) {
    checkAbort(signal);
    const full = `[[SRC:${block.id}]] [${block.identityTag}]\n${sanitizeForMarkers(block.text)}`;
    if (textBytes(full) <= budgets.notesBudget) {
      normalizedBlocks.push({ text: full, sourceIds: [block.id] });
      continue;
    }
    normalizedBlocks.push(await reduceSingleSourceBlock(block.id, block.identityTag, block.text, budgets.notesBudget, budgets.reduceOutputTokens, signal));
  }

  const reduceChunk = async (chunkText: string, chunkSourceIds: string[]): Promise<{ text: string; sourceIds: string[] }> => {
    const reduced = await callLLM(REDUCE_SYSTEM, chunkText, undefined, budgets.reduceOutputTokens, true, { signal, timeoutMs: 60000 });
    if (!reduced.trim() || textBytes(reduced) > budgets.notesBudget) {
      throw new Error(`Bounded note reduction output is empty or exceeds ${budgets.notesBudget} bytes`);
    }
    const retainedIds = assertSourceSubsetOrThrow(reduced, chunkSourceIds, `Diary reduction ${localDate}`);
    if (chunkSourceIds.length > 0 && retainedIds.length === 0) {
      throw new Error(`Diary reduction ${localDate} dropped all source markers for chunk`);
    }
    return { text: reduced, sourceIds: retainedIds };
  };

  let current = packSourceBlocks(normalizedBlocks, budgets.notesBudget);
  if (!current.length) return "";

  while (current.length > 1 || textBytes(current[0].text) > budgets.notesBudget) {
    const next: Array<{ text: string; sourceIds: string[] }> = [];
    for (const chunk of current) {
      checkAbort(signal);
      if (textBytes(chunk.text) <= budgets.notesBudget && current.length === 1) {
        next.push(chunk);
        continue;
      }
      next.push(await reduceChunk(chunk.text, chunk.sourceIds));
    }

    const packed = packSourceBlocks(next, budgets.notesBudget);
    const oldBytes = current.reduce((sum, item) => sum + textBytes(item.text), 0);
    const newBytes = packed.reduce((sum, item) => sum + textBytes(item.text), 0);
    if (newBytes >= oldBytes && packed.length >= current.length) {
      throw new Error("Diary bounded-note reduction did not shrink; refusing partial facts");
    }
    current = packed;
  }

  const finalText = current[0].text.trim();
  if (!finalText) return "";
  assertSourceSubsetOrThrow(finalText, current[0].sourceIds, `Diary final bounded notes ${localDate}`);
  return finalText;
}

function validateSources(content: DailyDiaryContent, allowedSourceIds: string[]): void {
  const allowed = new Set(allowedSourceIds);
  const rows = [...content.timeline, ...content.topics, ...content.commitments, ...content.unresolved];
  for (const row of rows) {
    if (!Array.isArray(row.sourceSegmentIds) || row.sourceSegmentIds.length === 0) {
      throw new Error("Daily diary item missing sourceSegmentIds evidence");
    }
  }
  const used = flattenSourceIds(content);
  if (allowed.size > 0 && used.length === 0) {
    throw new Error("Daily diary output contains no usable source markers");
  }
  for (const sourceId of used) {
    if (!allowed.has(sourceId)) {
      throw new Error(`Daily diary referenced unknown source ID: ${sourceId}`);
    }
  }
}

function validateNeutralDailyContent(content: DailyDiaryContent): void {
  assertNoObviousFirstPerson(content.summaryNeutral, "Daily summaryNeutral");
  for (const row of content.timeline) {
    assertNoObviousFirstPerson(row.timeHint, "Daily timeline.timeHint");
    assertNoObviousFirstPerson(row.event, "Daily timeline.event");
  }
  for (const row of content.topics) {
    assertNoObviousFirstPerson(row.topic, "Daily topics.topic");
    assertNoObviousFirstPerson(row.details, "Daily topics.details");
  }
  for (const row of content.commitments) {
    assertNoObviousFirstPerson(row.item, "Daily commitments.item");
    assertNoObviousFirstPerson(row.owner, "Daily commitments.owner");
    assertNoObviousFirstPerson(row.due, "Daily commitments.due");
  }
  for (const row of content.unresolved) {
    assertNoObviousFirstPerson(row.item, "Daily unresolved.item");
  }
}

export async function initDiaryService(): Promise<void> {
  await initDiaryStorage();
  await recoverDiaryStaleStates();
}

export async function getDiaryRuntimeStatus(): Promise<DiaryRuntimeStatus> {
  const [settings, queue, native] = await Promise.all([
    getDiarySettings(),
    getDiaryQueueStats(),
    getNativeStatusOrDefault(),
  ]);
  return {
    supported: isSupportedPlatform(),
    platformMessage: platformMessage(),
    native,
    settings,
    queue,
    processingActive,
    enrollmentActive,
  };
}

export async function setDiaryConsentGranted(enabled: boolean): Promise<void> {
  if (enabled) {
    await withLifecycleMutation("updating-consent", async () => {
      await setDiaryConsent(true);
    });
    return;
  }

  await withLifecycleMutation("revoking-consent", async () => {
    await setDiaryConsent(false);
    const status = await getNativeStatusOrDefault();
    if (status.active) {
      const native = await getNative();
      if (native) await native.stopDiary();
      await stopCaptureAndWaitInactive();
    }
    await cancelAndDrainDiaryWorkers();
  });
}

export async function setDiaryRetentionPolicy(days: DiaryRetentionDays): Promise<void> {
  await setDiaryRetentionDays(days);
}

export async function prepareDiaryModels(): Promise<void> {
  const native = await getNative();
  if (!native) throw new Error(platformMessage());
  await native.prepareDiaryModels();
}

export async function startDiaryCapture(): Promise<void> {
  await withLifecycleMutation("starting-capture", async () => {
    const settings = await getDiarySettings();
    if (!settings.consentGranted) {
      throw new Error("Consent is required before diary capture can start");
    }
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await ensureDiaryMicPermission(native);
    await native.startDiary();
    await checkConsentOrThrow("capture start");
  });
}

export async function stopDiaryCapture(): Promise<void> {
  await withLifecycleMutation("stopping-capture", async () => {
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await native.stopDiary();
    await stopCaptureAndWaitInactive();
  });
}

export async function pauseDiaryCapture(): Promise<void> {
  await withLifecycleMutation("pausing-capture", async () => {
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await native.pauseDiary();
  });
}

export async function resumeDiaryCapture(): Promise<void> {
  await withLifecycleMutation("resuming-capture", async () => {
    await checkConsentOrThrow("capture resume");
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await native.resumeDiary();
  });
}

export async function importDiarySegmentsFromNative(): Promise<{ inserted: number; updated: number; unchanged: number }> {
  const startEpoch = await assertLifecycleOpen("segment import");
  const settings = await getDiarySettings();
  if (!settings.consentGranted) return { inserted: 0, updated: 0, unchanged: 0 };
  const native = await getNative();
  if (!native) return { inserted: 0, updated: 0, unchanged: 0 };
  checkLifecycleOrThrow(startEpoch, "segment import");
  const segments = await native.listDiarySegments();
  checkLifecycleOrThrow(startEpoch, "segment import result");
  await checkConsentOrThrow("segment import");
  return importNativeDiarySegments(segments);
}

export async function listDiaryDays(limit = 30): Promise<DailyDiary[]> {
  return listDailyDiaryEntries(limit);
}

export async function listSegmentsForDate(localDate: string): Promise<DiarySegment[]> {
  return listDiarySegmentsByDate(localDate);
}

export async function retrySegment(id: string): Promise<void> {
  await markSegmentState(id, "pending", "");
}

export async function confirmSegmentIdentity(id: string, identity: DiaryManualIdentity, note = ""): Promise<void> {
  await withLifecycleMutation("confirming-identity", async () => {
    const segment = await getDiarySegment(id);
    await setManualSegmentIdentity(id, identity, note);
    await clearSegmentCheckpoints(id);
    if (segment) {
      await markDayDirty(segment.localDate, "identity-confirmed", true);
    }
  });
}

export async function deleteSingleSegment(id: string, includeDerived = false): Promise<void> {
  await withLifecycleMutation("deleting-segment", async () => {
    await cancelAndDrainDiaryWorkers();
    const status = await getNativeStatusOrDefault();
    if (status.active) throw new Error("Cannot delete while diary capture is active");

    const segment = await getDiarySegment(id);
    await clearSegmentCheckpoints(id, !!segment?.filePath);

    const native = await getNative();
    if (native) {
      try {
        await native.deleteDiarySegment(id);
      } catch {
        // Keep local state truthful even if native orphan cleanup misses this id.
      }
    }

    if (includeDerived) {
      await deleteSegment(id);
      if (segment) {
        await markDayDirty(segment.localDate, "segment-deleted", true);
      }
      return;
    }

    await markSegmentAudioDeleted(id);
  });
}

export async function processDiaryQueue(limit = 4): Promise<{ processed: number; failed: number; skipped: boolean }> {
  await waitForLifecycleMutation();
  const settings = await getDiarySettings();
  if (!settings.consentGranted) return { processed: 0, failed: 0, skipped: true };
  if (processingActive) return { processed: 0, failed: 0, skipped: true };

  const run = (async () => {
    const startEpoch = await assertLifecycleOpen("queue processing");
    processingActive = true;
    processingAbort = new AbortController();
    let processed = 0;
    let failed = 0;

    try {
      checkLifecycleOrThrow(startEpoch, "queue import");
      await checkConsentOrThrow("queue import");
      await importDiarySegmentsFromNative();
      checkLifecycleOrThrow(startEpoch, "queue load pending");
      const pending = await listPendingDiarySegments(Math.max(1, limit));

      for (const segment of pending) {
        try {
          checkAbort(processingAbort.signal);
          checkLifecycleOrThrow(startEpoch, `segment ${segment.id}`);
          await checkConsentOrThrow(`segment ${segment.id}`);
          await markSegmentState(segment.id, "transcribing", "");

          let speakerAuto: DiarySpeakerAuto = "unknown";
          let speakerSimilarity: number | null = null;
          let profileRevision: string | null = null;
          let speakerWindows: DiarySpeakerWindow[] = [];

          try {
            const native = await getNative();
            if (native) {
              const speaker = await native.identifySpeaker(segment.filePath);
              speakerAuto = speaker.speaker;
              speakerSimilarity = speaker.similarity;
              profileRevision = speaker.profileRevision;
              speakerWindows = Array.isArray(speaker.windows) ? speaker.windows : [];
            }
          } catch {
            speakerAuto = "unknown";
          }

          checkAbort(processingAbort.signal);
          checkLifecycleOrThrow(startEpoch, `segment ${segment.id} after identify`);
          await checkConsentOrThrow(`segment ${segment.id} after identify`);

          const transcript = await transcribeRemote(
            segment.filePath as string,
            processingAbort.signal,
            segmentTranscriptScope(segment.id),
          );
          checkAbort(processingAbort.signal);
          checkLifecycleOrThrow(startEpoch, `segment ${segment.id} after stt`);
          await checkConsentOrThrow(`segment ${segment.id} after stt`);

          const reducedNeutral = await compactTranscript(sanitizeForMarkers(transcript), undefined, {
            signal: processingAbort.signal,
            checkpointScope: segmentNotesScope(segment.id),
          });
          if (segment.manualIdentity !== "confirmed_self") {
            assertNoObviousFirstPerson(reducedNeutral, `Segment ${segment.id} factual notes`);
          }
          const factualNotes = `[[SRC:${segment.id}]] [${segmentIdentityTag(segment)}]\n${sanitizeForMarkers(reducedNeutral.trim())}`;

          checkAbort(processingAbort.signal);
          checkLifecycleOrThrow(startEpoch, `segment ${segment.id} before save`);
          await checkConsentOrThrow(`segment ${segment.id} before save`);
          await markSegmentResult(segment.id, {
            transcript,
            factualNotes,
            speakerAuto,
            speakerSimilarity,
            profileRevision,
            windows: speakerWindows,
          });
          processed += 1;
        } catch (error: any) {
          if (isAbortError(error)) {
            await markSegmentState(segment.id, "pending", "");
            continue;
          }
          failed += 1;
          await markSegmentState(segment.id, "failed", error?.message ?? "Diary segment processing failed");
        }
      }

      return { processed, failed, skipped: false };
    } finally {
      processingAbort = null;
      processingActive = false;
    }
  })();

  processingPromise = run;
  try {
    return await run;
  } finally {
    if (processingPromise === run) processingPromise = null;
  }
}

export function cancelDiaryProcessing(): void {
  processingAbort?.abort();
}

export async function generateDailyDiary(localDate: string, signal?: AbortSignal): Promise<DailyDiary> {
  await waitForLifecycleMutation();
  const startEpoch = await assertLifecycleOpen(`daily generation ${localDate}`);
  await checkConsentOrThrow(`daily generation ${localDate}`);
  const linked = createLinkedAbortSignal(signal);
  const promise = (async () => {
    const modelConfig = await getModelConfig();
    const budgets = buildDiaryBudgets(localDate, modelConfig.contextLimit);
    const segments = await listDiarySegmentsByDate(localDate);
    const doneSegments = segments.filter(item => item.state === "done");
    if (!doneSegments.length) {
      const emptyContent: DailyDiaryContent = {
        summaryNeutral: "",
        timeline: [],
        topics: [],
        commitments: [],
        unresolved: [],
        caveat: "Sources are references, not proof.",
      };
      await saveDailyDiary(localDate, { notes: "", sourceSegmentIds: [], content: emptyContent });
      const saved = await getDailyDiary(localDate);
      if (!saved) throw new Error("Failed to save empty daily diary");
      return saved;
    }

    const sourceSegmentIds = doneSegments.map(item => item.id);
    await saveDailyDiaryDraft(localDate, { state: "generating", notes: "", sourceSegmentIds });
    const draft = await getDailyDiary(localDate);
    const draftVersion = draft?.version;

    try {
      checkLifecycleOrThrow(startEpoch, `daily generation ${localDate} before bounded notes`);
      await checkConsentOrThrow(`daily generation ${localDate} before bounded notes`);
      const boundedNotes = await buildBoundedDayNotes(localDate, doneSegments, budgets, linked.signal);
      checkAbort(linked.signal);
      checkLifecycleOrThrow(startEpoch, `daily generation ${localDate} before final`);
      await checkConsentOrThrow(`daily generation ${localDate} before final`);

      const retainedSourceIds = extractSourceMarkers(boundedNotes);
      if (boundedNotes.trim() && retainedSourceIds.length === 0) {
        throw new Error(`Bounded notes for ${localDate} contain no machine source markers`);
      }

      const finalRaw = await callLLM(
        DAILY_SYSTEM,
        `${budgets.finalUserPrefix}${boundedNotes || "No notes available. Return empty arrays."}`,
        undefined,
        budgets.finalOutputTokens,
        true,
        { signal: linked.signal, timeoutMs: 90000 },
      );
      checkAbort(linked.signal);
      checkLifecycleOrThrow(startEpoch, `daily generation ${localDate} after final`);
      await checkConsentOrThrow(`daily generation ${localDate} after final`);

      const parsed = safeParseJson(finalRaw);
      const content = normalizeContent(parsed);
      validateNeutralDailyContent(content);
      validateSources(content, retainedSourceIds);
      await saveDailyDiary(
        localDate,
        {
          notes: boundedNotes,
          sourceSegmentIds: retainedSourceIds,
          content,
        },
        draftVersion,
      );
      const saved = await getDailyDiary(localDate);
      if (!saved) throw new Error("Daily diary save failed");
      return saved;
    } catch (error: any) {
      if (!isAbortError(error)) {
        await markDailyDiaryFailed(localDate, error?.message ?? "Daily generation failed");
      }
      throw error;
    }
  })();

  registerGeneration(localDate, linked.controller, promise);
  try {
    return await promise;
  } finally {
    unregisterGeneration(localDate);
    linked.dispose();
  }
}

export async function handleDiaryForeground(): Promise<void> {
  await assertLifecycleOpen("foreground processing");
  const settings = await getDiarySettings();
  if (!settings.consentGranted) return;
  await importDiarySegmentsFromNative();
  await processDiaryQueue(6);
}

export async function startVoiceEnrollmentCapture(): Promise<void> {
  await assertLifecycleOpen("start enrollment");
  if (!isSupportedPlatform()) throw new Error(platformMessage());
  if (enrollmentActive) throw new Error("Enrollment capture is already active");
  if (isRecordingActive()) throw new Error("Another recording is active");
  const started = await startRecording();
  if (started.simulated) {
    await cleanupRecording();
    throw new Error("Native recording is required for voice enrollment");
  }
  enrollmentActive = true;
}

export async function finishVoiceEnrollmentCapture(): Promise<{ durationMs: number }> {
  await assertLifecycleOpen("finish enrollment");
  if (!enrollmentActive) throw new Error("Enrollment capture is not active");
  enrollmentActive = false;
  let uri = "";
  let durationMs = 0;
  try {
    const result = await stopRecording();
    uri = result.uri;
    durationMs = result.durationMs;
    if (durationMs < 15000 || durationMs > 30000) {
      throw new Error("Enrollment sample must be between 15 and 30 seconds");
    }
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await native.enrollSpeaker(uri);
    const invalidated = await clearAutoSpeakerEvidence();
    for (const id of invalidated.segmentIds) {
      await deleteProcessingCheckpoints(segmentNotesScope(id));
    }
    for (const date of invalidated.localDates) {
      await markDayDirty(date, "voice-profile-reenrolled", true);
    }
    return { durationMs };
  } finally {
    if (uri) await deleteFile(uri);
  }
}

export async function cancelVoiceEnrollmentCapture(): Promise<void> {
  if (!enrollmentActive) return;
  enrollmentActive = false;
  try {
    const result = await stopRecording();
    if (result.uri) await deleteFile(result.uri);
  } catch {
    await cleanupRecording();
  }
}

export async function deleteVoiceProfile(): Promise<void> {
  await withLifecycleMutation("deleting-voice-profile", async () => {
    await cancelAndDrainDiaryWorkers();
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await native.deleteSpeakerProfile();
    const invalidated = await clearAutoSpeakerEvidence();
    for (const id of invalidated.segmentIds) {
      await deleteProcessingCheckpoints(segmentNotesScope(id));
    }
    for (const date of invalidated.localDates) {
      await markDayDirty(date, "voice-profile-deleted", true);
    }
  });
}

export async function getRetentionPlan(nowIso?: string) {
  return planRetentionCleanup(nowIso);
}

export async function applyRetentionPlan(options: { allowUnprocessedDelete: boolean }): Promise<{ deleted: string[]; blocked: string[] }> {
  return withLifecycleMutation("retention-cleanup", async () => {
    await cancelAndDrainDiaryWorkers();
    const status = await getNativeStatusOrDefault();
    if (status.active) throw new Error("Cannot run retention cleanup while diary capture is active");
    const plan = await planRetentionCleanup();
    if (plan.blockedUnprocessedSegmentIds.length && !options.allowUnprocessedDelete) {
      throw new Error("Retention plan has unprocessed backlog; explicit confirmation required");
    }

    const native = await getNative();
    const deletable = options.allowUnprocessedDelete
      ? [...plan.deletableSegmentIds, ...plan.blockedUnprocessedSegmentIds]
      : plan.deletableSegmentIds;

    const deleted: string[] = [];
    const blocked: string[] = [];
    const dirtyDates = new Set<string>();
    for (const id of deletable) {
      const segment = await getDiarySegment(id);
      await clearSegmentCheckpoints(id, !!segment?.filePath);
      try {
        if (native) await native.deleteDiarySegment(id);
        if (segment) dirtyDates.add(segment.localDate);
        deleted.push(id);
      } catch {
        blocked.push(id);
      }
    }
    await deleteSegmentsByIds(deleted);
    for (const date of dirtyDates) {
      await markDayDirty(date, "retention-delete", true);
    }
    return { deleted, blocked };
  });
}

export async function purgeDiaryData(includeDerived: boolean): Promise<void> {
  await withLifecycleMutation("purging-diary-data", async () => {
    await deleteProcessingCheckpoints("diary:", true);
    await cancelAndDrainDiaryWorkers();

    const status = await getNativeStatusOrDefault();
    if (status.active) throw new Error("Stop diary capture before deleting diary data");

    const native = await getNative();
    const knownLocalSegments = await listAllDiarySegments();
    const allSegmentIds = new Set(knownLocalSegments.map(item => item.id));

    if (native) {
      const imported = await native.listDiarySegments();
      for (const segment of imported) {
        allSegmentIds.add(segment.id);
        try {
          await native.deleteDiarySegment(segment.id);
        } catch {
          // Keep local metadata to expose native deletion failures.
        }
      }
    }

    if (includeDerived) {
      await clearAllDiaryData(true);
      await deleteProcessingCheckpoints("diary:", true);
      await deleteProcessingCheckpoints("remote-stt");
      return;
    }

    await markSegmentsAudioDeleted(Array.from(allSegmentIds));
    for (const id of allSegmentIds) {
      await clearSegmentCheckpoints(id, true);
    }
  });
}
