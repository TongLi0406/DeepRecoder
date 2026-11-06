import { Platform } from "react-native";
import { callLLM, getModelConfig } from "./api";
import { compactTranscript } from "./summarization";
import { compactText, textBytes, checkAbort, DIARY_NOTES_BUDGET } from "./llmContext";
import { debugLog } from "./debug";
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
  createNativeSegmentImportCache,
  initDiaryStorage,
  listDailyDiaryEntries,
  listDiarySegmentIds,
  listDiarySegmentsByDate,
  listFailedDiarySegments,
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
  listDiarySegmentsPage(offset: number, limit: number): Promise<DiaryNativeSegment[]>;
  deleteDiarySegment(id: string): Promise<void>;
  identifySpeaker(path: string): Promise<{ speaker: "matched" | "unknown"; similarity: number | null; profileRevision: string | null; windows: DiarySpeakerWindow[] }>;
  enrollSpeaker(path: string): Promise<void>;
  deleteSpeakerProfile(): Promise<void>;
};

const REDUCE_SYSTEM = `Compress diary segment notes while preserving source labels [[SRC:segment-id]].
Keep only neutral facts, timeline markers, decisions, commitments and unresolved issues.
Never invent identity or first-person ownership.
Do not remove or rewrite source labels.
Always write the compressed notes in Simplified Chinese. Translate non-Chinese content into Chinese; keep proper nouns (names, places, titles) in their original form.`;

const DAILY_SYSTEM = `Generate a daily diary JSON from bounded notes.
Rules:
1) Unknown or mixed identity must stay neutral.
2) sourceSegmentIds must only include IDs present in input source labels [[SRC:segment-id]].
3) Do not claim citations are proof.
4) If evidence is insufficient, use empty arrays.
5) Every non-empty timeline/topic/commitment/unresolved item must include at least one sourceSegmentIds entry.
6) Never invent source IDs.
7) Never use first-person pronouns (I, we, my, our, 我, 我们); refer to speakers neutrally.
8) Write every human-readable field in Simplified Chinese, even if the notes are in another language. Translate facts into Chinese; keep proper nouns (names, places, titles, product names) in their original form.
9) Keep the JSON compact: at most 6 timeline entries, 6 topics, 4 commitments and 4 unresolved items; keep each text field under 80 Chinese characters.

Return strict JSON with:
{
  "summaryNeutral": "...",
  "timeline": [{"timeHint":"", "event":"", "sourceSegmentIds":["S1"]}],
  "topics": [{"topic":"", "details":"", "sourceSegmentIds":["S1"]}],
  "commitments": [{"item":"", "owner":"", "due":"", "sourceSegmentIds":["S1"]}],
  "unresolved": [{"item":"", "sourceSegmentIds":["S1"]}],
  "caveat": "来源仅供参考，不构成证据。"
}`;

type DiaryQueueRun = {
  id: number;
  abort: AbortController;
  startedAt: number;
  lastActivityAt: number;
  inFlight: number;
};

// 单个片段最长处理时间：上传 110s + 笔记归并 90s + 余量
const SEGMENT_TIMEOUT_MS = 4 * 60_000;
// 整条队列超过该时间没有任何片段进展，视为卡死，允许下一次触发接管
const STALE_RUN_MS = 6 * 60_000;
// 短转写直接作为笔记，省掉一次模型调用（长转写仍然归并压缩）
const DIRECT_NOTES_MAX_BYTES = 2000;

// 远端账户余额/鉴权失败时暂停队列，避免把几千条片段的重试次数白白耗光
const QUOTA_COOLDOWN_MS = 10 * 60_000;
const QUOTA_ERROR_RE = /HTTP 402|HTTP 401|payment required|insufficient_quota|余额|额度|欠费/i;
let quotaBlockedUntil = 0;

let queueRun: DiaryQueueRun | null = null;
let queueRunCounter = 0;
let enrollmentActive = false;
let processingPromise: Promise<{ processed: number; failed: number; deleted: number; skipped: boolean }> | null = null;
const generatingControllers = new Map<string, AbortController>();
const generatingPromises = new Map<string, Promise<DailyDiary>>();
let lifecycleEpoch = 0;
let lifecycleMutation: Promise<void> = Promise.resolve();
let lifecycleMutationReason = "";

function makeAbortError(message = "日记操作已取消"): Error {
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

const NOISE_TAG_RE = /(?:【|\[|\()\s*(音乐|掌声|笑声|噪声|噪音|环境音|静音|silence|music|noise|applause|laughter)\s*(?:】|\]|\))/gi;
const LETTER_OR_NUMBER_RE = /\p{L}|\p{N}/gu;

function isMeaninglessTranscript(text: string): boolean {
  // 去掉标点、空白和常见非语音标注后，少于 2 个有效字符（如单个语气词）视为无意义
  return (text.replace(NOISE_TAG_RE, "").match(LETTER_OR_NUMBER_RE)?.length ?? 0) < 2;
}

async function deleteMeaninglessSegment(segment: { id: string; filePath: string }): Promise<void> {
  await clearSegmentCheckpoints(segment.id, !!segment.filePath);
  const native = await getNative();
  if (native) {
    try {
      await native.deleteDiarySegment(segment.id);
    } catch {
      // 原生文件清理失败时仍然删除本地记录，避免无意义片段反复进入队列
    }
  }
  await deleteSegment(segment.id);
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
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
  queueRun?.abort.abort();
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
  if (Platform.OS === "android") return "日记采集已在 Android 设备上就绪。";
  if (Platform.OS === "ios") return "当前构建在 iOS 上不支持日记采集。";
  return "日记采集仅支持 Android，Web 无法模拟后台采集。";
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
      throw new Error("麦克风权限被拒绝");
    }
  }
  if (native?.hasPermission && !native.hasPermission()) {
    throw new Error("麦克风权限被拒绝");
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

function dropOutOfScopeMarkers(text: string, allowedIds: string[]): string {
  const allowed = new Set(allowedIds);
  return text.replace(/\[\[SRC:([A-Za-z0-9._-]+)\]\]/g, (match, id) => (allowed.has(id) ? match : ""));
}

// 按 UTF-8 字节数截断，优先在换行或句号处收尾，保证单个分块不会超预算
function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (textBytes(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (textBytes(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = lo;
  const lastBreak = Math.max(text.lastIndexOf("\n", cut), text.lastIndexOf("。", cut));
  if (lastBreak > cut / 2) cut = lastBreak + 1;
  // 截断可能把末尾的来源标记切成半截，清掉不完整的标记
  return text.slice(0, cut).replace(/\[\[SRC:[^\]]*$/g, "").trim();
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
  const finalOutputTokens = 8192;
  const finalUserPrefix = `Local date: ${localDate}\nSummarize strictly from notes with [[SRC:*]] evidence.\n\n`;
  const protocolReserve = 1024;
  const available = contextLimit - textBytes(DAILY_SYSTEM) - textBytes(finalUserPrefix) - finalOutputTokens - protocolReserve;
  // 存储层的每日笔记上限，生成预算与存储必须一致，否则会生成完却保存失败
  const notesBudget = Math.min(DIARY_NOTES_BUDGET, Math.max(128, Math.floor(available)));
  if (notesBudget < 128 || contextLimit < 8192) {
    throw new Error(`Model context ${contextLimit} is insufficient for minimum diary generation budget`);
  }
  // 归并输入可能接近 6000 字节，输出上限必须足够大，否则会被 finish_reason=length 截断
  const reduceOutputTokens = 8192;
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
    caveat: "来源仅供参考，不构成证据。",
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
      error: error?.message ?? "日记状态不可用",
      hasSpeakerProfile: false,
      modelsReady: false,
    };
  }
}

async function stopCaptureAndWaitInactive(): Promise<void> {
  const native = await getNative();
  const delays = [60, 100, 150, 250, 400, 600, 800];
  for (const delayMs of delays) {
    const status = await getNativeStatusOrDefault();
    if (!status.active) return;
    // 停止请求可能早于服务真正启动完成，这里持续补发停止，确保最终一定停住
    await native?.stopDiary().catch(() => {});
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
      const capped = truncateToBytes(dropOutOfScopeMarkers(next.trim(), [sourceId]), notesBudget);
      if (!capped) {
        throw new Error(`Single-source reduction output invalid for ${sourceId}`);
      }
      return capped;
    },
    notesBudget,
    signal,
  );

  return { text: `[[SRC:${sourceId}]] [${identityTag}]\n${dropOutOfScopeMarkers(sanitizeForMarkers(reducedBody.trim()), [sourceId])}`, sourceIds: [sourceId] };
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
    normalizedBlocks.push(await reduceSingleSourceBlock(block.id, block.identityTag, block.text, budgets.notesBudget, Math.min(budgets.reduceOutputTokens, 4096), signal));
  }

  const reduceChunk = async (chunkText: string, chunkSourceIds: string[], targetBytes: number): Promise<{ text: string; sourceIds: string[] }> => {
    // 输入过长时单次输出可能被 max_tokens 截断；按换行对半拆分后分别归并
    const callReduce = async (text: string, depth: number): Promise<string> => {
      try {
        // 预算放大后单次归并输入可能很大，超时时间随输入大小放宽
        const timeoutMs = Math.min(180_000, 60_000 + Math.floor(textBytes(text) / 1000) * 500);
        return await callLLM(
          `${REDUCE_SYSTEM}\n输出必须控制在 ${targetBytes} 字节以内，优先保留带 [[SRC:...]] 标记的关键事实。`,
          text,
          undefined,
          budgets.reduceOutputTokens,
          true,
          { signal, timeoutMs },
        );
      } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (depth >= 3 || !/截断/.test(message)) throw error;
        const mid = Math.floor(text.length / 2);
        const before = text.lastIndexOf("\n", mid);
        const after = text.indexOf("\n", mid);
        const cut = before > 0 ? before : after;
        if (cut <= 0 || cut >= text.length - 1) throw error;
        const left = await callReduce(text.slice(0, cut), depth + 1);
        const right = await callReduce(text.slice(cut + 1), depth + 1);
        return `${left}\n${right}`;
      }
    };
    const reduced = await callReduce(chunkText, 0);
    if (!reduced.trim()) {
      throw new Error(`Bounded note reduction output is empty for ${localDate}`);
    }
    // 模型偶尔会带出其他分块的来源 ID，直接丢弃而不是让整篇日记失败
    let cleaned = dropOutOfScopeMarkers(reduced, chunkSourceIds).trim();
    if (!cleaned) {
      throw new Error(`Bounded note reduction output is empty for ${localDate}`);
    }
    cleaned = truncateToBytes(cleaned, targetBytes);
    // 模型偶尔会完全丢掉来源标记；补回该分块自身的来源，保证事实仍可追溯
    if (extractSourceMarkers(cleaned).length === 0 && chunkSourceIds.length > 0) {
      const markerSuffix = chunkSourceIds.slice(0, 4).map(id => `[[SRC:${id}]]`).join(" ");
      cleaned = truncateToBytes(cleaned, Math.max(200, targetBytes - textBytes(markerSuffix)));
      cleaned = `${cleaned}\n${markerSuffix}`.trim();
    }
    if (!cleaned) {
      throw new Error(`Bounded note reduction output is empty for ${localDate}`);
    }
    const retainedIds = assertSourceSubsetOrThrow(cleaned, chunkSourceIds, `Diary reduction ${localDate}`);
    return { text: cleaned, sourceIds: retainedIds };
  };

  // 先用半预算打包，给归并输出留出余量，避免单次输出超过存储上限
  let current = packSourceBlocks(normalizedBlocks, Math.floor(budgets.notesBudget / 2));
  if (!current.length) return "";

  let round = 0;
  let stagnantRounds = 0;
  const totalBytesOf = (items: Array<{ text: string }>) => items.reduce((sum, item) => sum + textBytes(item.text), 0);
  // 只要总字节数在预算内就停止，不要求压成单一分块
  while (totalBytesOf(current) > budgets.notesBudget) {
    round += 1;
    if (round > 8) {
      throw new Error("Daily notes reduction exceeded round limit");
    }
    const totalBytes = totalBytesOf(current);
    debugLog(`[DiaryPerf] reduce round=${round} chunks=${current.length} bytes=${totalBytes}`);
    // 每轮的归并互相独立，有限并发可显著缩短日记生成时间
    const perChunkTarget = Math.max(400, Math.floor(budgets.notesBudget / current.length));
    const next = await mapLimited(current, 3, async chunk => {
      checkAbort(signal);
      return reduceChunk(chunk.text, chunk.sourceIds, perChunkTarget);
    });

    const packed = packSourceBlocks(next, budgets.notesBudget);
    const oldBytes = totalBytesOf(current);
    const newBytes = totalBytesOf(packed);
    // 允许某一轮字节数略增，只要总字节仍有下降就继续；连续两轮没有进展才失败
    if (newBytes >= oldBytes) {
      stagnantRounds += 1;
      if (stagnantRounds >= 2) {
        throw new Error("Diary bounded-note reduction did not shrink; refusing partial facts");
      }
    } else {
      stagnantRounds = 0;
    }
    current = packed;
  }

  const finalText = current.map(item => item.text.trim()).filter(Boolean).join("\n\n");
  if (!finalText) return "";
  assertSourceSubsetOrThrow(finalText, current.flatMap(item => item.sourceIds), `Diary final bounded notes ${localDate}`);
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

// 界面轮询只取轻量队列统计，避免被正在进行的原生转写请求拖慢
export { getDiaryQueueStats };

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
    processingActive: queueRun !== null,
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
    const startEpoch = lifecycleEpoch;
    const settings = await getDiarySettings();
    if (!settings.consentGranted) {
      throw new Error("需要先授予隐私授权才能开始采集");
    }
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    await ensureDiaryMicPermission(native);
    // 启动途中如果用户点了停止，就不能再把服务拉起来
    if (startEpoch !== lifecycleEpoch) {
      throw makeAbortError("日记采集启动已被停止操作取消");
    }
    await native.startDiary();
    // 前台服务启动是异步的，轮询等待其真正就绪，避免界面读到旧的停止状态
    for (let i = 0; i < 10; i++) {
      const nativeStatus = await native.getDiaryStatus();
      if (nativeStatus.active) break;
      if (startEpoch !== lifecycleEpoch) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (startEpoch !== lifecycleEpoch) {
      // 停止操作已抢占启动流程，立即回滚原生服务
      await native.stopDiary().catch(() => {});
      throw makeAbortError("日记采集启动已被停止操作取消");
    }
    await checkConsentOrThrow("capture start");
  });
}

export async function stopDiaryCapture(): Promise<void> {
  // 停止采集是优先级操作：先抢占/中止正在跑的转写与生成任务，
  // 再直接停原生服务，不排在生命周期队列后面等待。
  lifecycleEpoch += 1;
  queueRun?.abort.abort();
  for (const controller of generatingControllers.values()) {
    controller.abort();
  }

  const native = await getNative();
  if (!native) throw new Error(platformMessage());
  await native.stopDiary();
  await stopCaptureAndWaitInactive();
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

  // 几千条片段一次性跨 JNI 转成 JS 对象会耗尽堆内存并让进程 abort，
  // 必须分页导入；已有记录缓存跨页复用，避免每页都全表扫描。
  const PAGE_SIZE = 300;
  const cache = await createNativeSegmentImportCache();
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let offset = 0;

  while (true) {
    checkLifecycleOrThrow(startEpoch, "segment import");
    await checkConsentOrThrow("segment import");
    const page = await native.listDiarySegmentsPage(offset, PAGE_SIZE);
    if (!page.length) break;
    const result = await importNativeDiarySegments(page, cache);
    inserted += result.inserted;
    updated += result.updated;
    unchanged += result.unchanged;
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
  }

  checkLifecycleOrThrow(startEpoch, "segment import result");
  return { inserted, updated, unchanged };
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

export async function deleteFailedSegments(): Promise<{ deleted: number }> {
  return withLifecycleMutation("deleting-failed-segments", async () => {
    await cancelAndDrainDiaryWorkers();
    const status = await getNativeStatusOrDefault();
    if (status.active) throw new Error("采集中无法删除片段");
    const failed = await listFailedDiarySegments();
    if (!failed.length) return { deleted: 0 };

    const native = await getNative();
    for (const segment of failed) {
      await clearSegmentCheckpoints(segment.id, !!segment.filePath);
      if (native) {
        try {
          await native.deleteDiarySegment(segment.id);
        } catch {
          // 原生文件清理失败时仍然删除本地记录，避免失败片段反复堆积
        }
      }
    }
    await deleteSegmentsByIds(failed.map(item => item.id));
    // 失败片段从未参与日记生成，删除它们不需要把已生成的日记标记为过期
    return { deleted: failed.length };
  });
}

export async function processDiaryQueue(limit = 4): Promise<{ processed: number; failed: number; deleted: number; skipped: boolean }> {
  await waitForLifecycleMutation();
  const settings = await getDiarySettings();
  if (!settings.consentGranted) return { processed: 0, failed: 0, deleted: 0, skipped: true };

  if (quotaBlockedUntil > Date.now()) {
    console.error(`[DiaryQueue] skip: remote quota blocked, retry in ${Math.ceil((quotaBlockedUntil - Date.now()) / 1000)}s`);
    return { processed: 0, failed: 0, deleted: 0, skipped: true };
  }

  if (queueRun) {
    const idleMs = Date.now() - queueRun.lastActivityAt;
    if (idleMs < STALE_RUN_MS) return { processed: 0, failed: 0, deleted: 0, skipped: true };
    // 旧任务可能卡在不可中断的原生等待上，允许后台 tick 接管，避免整个队列永久停摆
    console.error(`[DiaryQueue] takeover stale run=${queueRun.id} idle=${Math.round(idleMs / 1000)}s inflight=${queueRun.inFlight}`);
    const stale = queueRun;
    queueRun = null;
    stale.abort.abort();
  }

  const run: DiaryQueueRun = {
    id: ++queueRunCounter,
    abort: new AbortController(),
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    inFlight: 0,
  };
  queueRun = run;
  const runSignal = run.abort.signal;

  const runPromise = (async () => {
    const startEpoch = await assertLifecycleOpen("queue processing");
    let processed = 0;
    let failed = 0;
    let deleted = 0;

    const processSegment = async (segment: DiarySegment): Promise<void> => {
      const linked = createLinkedAbortSignal(runSignal);
      const attemptStartedAt = Date.now();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        linked.controller.abort();
      }, SEGMENT_TIMEOUT_MS);
      run.inFlight += 1;
      run.lastActivityAt = Date.now();
      try {
        const signal = linked.signal;
        checkAbort(signal);
        checkLifecycleOrThrow(startEpoch, `segment ${segment.id}`);
        await checkConsentOrThrow(`segment ${segment.id}`);
        await markSegmentState(segment.id, "transcribing", "");

        // 过短的片段基本是环境噪声，直接删除，避免为无意义音频消耗一次远端转写
        if (segment.durationMs > 0 && segment.durationMs < 500) {
          debugLog(`[DiaryPerf] ${segment.id} skipped=short duration=${segment.durationMs}ms`);
          await deleteMeaninglessSegment(segment);
          deleted += 1;
          return;
        }

        let speakerAuto: DiarySpeakerAuto = "unknown";
        let speakerSimilarity: number | null = null;
        let profileRevision: string | null = null;
        let speakerWindows: DiarySpeakerWindow[] = [];

        const identifyStartedAt = Date.now();
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
        debugLog(`[DiaryPerf] ${segment.id} identify=${Date.now() - identifyStartedAt}ms`);

        checkAbort(signal);
        checkLifecycleOrThrow(startEpoch, `segment ${segment.id} after identify`);
        await checkConsentOrThrow(`segment ${segment.id} after identify`);

        let transcript: string;
        const sttStartedAt = Date.now();
        try {
          transcript = await transcribeRemote(
            segment.filePath as string,
            signal,
            segmentTranscriptScope(segment.id),
          );
        } catch (error) {
          if (isAbortError(error)) throw error;
          const message = error instanceof Error ? error.message : String(error ?? "");
          // 沉默/环境音片段没有可转写内容，或原始音频已被清理，直接删除而不是记成失败
          if (/返回空文本|empty text|音频文件不存在|audio_file_not_found/i.test(message)) {
            debugLog(`[DiaryPerf] ${segment.id} skipped=empty-stt`);
            await deleteMeaninglessSegment(segment);
            deleted += 1;
            return;
          }
          throw error;
        }
        quotaBlockedUntil = 0;
        checkAbort(signal);
        checkLifecycleOrThrow(startEpoch, `segment ${segment.id} after stt`);
        await checkConsentOrThrow(`segment ${segment.id} after stt`);
        debugLog(`[DiaryPerf] ${segment.id} stt=${Date.now() - sttStartedAt}ms chars=${transcript.length}`);

        if (isMeaninglessTranscript(transcript)) {
          debugLog(`[DiaryPerf] ${segment.id} skipped=meaningless`);
          await deleteMeaninglessSegment(segment);
          deleted += 1;
          return;
        }

        const notesStartedAt = Date.now();
        // 短转写本身已经是精简事实，直接作为笔记可省掉一次模型调用（积压时显著提速）
        const sanitized = sanitizeForMarkers(transcript);
        const reducedNeutral = textBytes(sanitized) <= DIRECT_NOTES_MAX_BYTES
          ? sanitized
          : await compactTranscript(sanitized, undefined, {
            signal,
            checkpointScope: segmentNotesScope(segment.id),
          });
        debugLog(`[DiaryPerf] ${segment.id} notes=${Date.now() - notesStartedAt}ms`);
        // 分段笔记里出现第一人称是正常的对话引用，不应整段失败；
        // 最终每日日记会统一做中性化校验。
        if (segment.manualIdentity !== "confirmed_self" && FIRST_PERSON_RE.test(reducedNeutral)) {
          debugLog(`[DiaryPerf] ${segment.id} notes contain first-person terms`);
        }
        const factualNotes = `[[SRC:${segment.id}]] [${segmentIdentityTag(segment)}]\n${sanitizeForMarkers(reducedNeutral.trim())}`;

        checkAbort(signal);
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
        run.lastActivityAt = Date.now();
        if (processed % 25 === 0) {
          console.error(`[DiaryQueue] progress run=${run.id} processed=${processed} failed=${failed} deleted=${deleted} elapsed=${Math.round((Date.now() - run.startedAt) / 1000)}s`);
        }
      } catch (error: any) {
        if (isAbortError(error)) {
          if (timedOut) {
            console.error(`[DiaryQueue] timeout ${segment.id} after ${Math.round((Date.now() - attemptStartedAt) / 1000)}s`);
          }
          debugLog(`[DiaryPerf] ${segment.id} ${timedOut ? "timeout" : "aborted"}`);
          await markSegmentState(segment.id, "pending", "").catch(() => {});
          return;
        }
        const message = error instanceof Error ? error.message : String(error ?? "");
        if (QUOTA_ERROR_RE.test(message)) {
          // 余额/鉴权问题重试没有意义：保留 pending，不消耗重试次数，并暂停整条队列
          quotaBlockedUntil = Date.now() + QUOTA_COOLDOWN_MS;
          console.error(`[DiaryQueue] paused (quota/auth): ${message}`);
          await markSegmentState(segment.id, "pending", "").catch(() => {});
          run.abort.abort();
          return;
        }
        failed += 1;
        console.error(`[DiaryQueue] seg failed ${segment.id} after ${Math.round((Date.now() - attemptStartedAt) / 1000)}s: ${message || "unknown"}`);
        debugLog(`[DiaryPerf] ${segment.id} failed=${error?.message ?? "unknown"}`);
        await markSegmentState(segment.id, "failed", error?.message ?? "Diary segment processing failed").catch(() => {});
      } finally {
        clearTimeout(timer);
        linked.dispose();
        run.inFlight -= 1;
        run.lastActivityAt = Date.now();
      }
    };

    try {
      console.error(`[DiaryQueue] begin run=${run.id}`);
      checkLifecycleOrThrow(startEpoch, "queue import");
      await checkConsentOrThrow("queue import");
      await importDiarySegmentsFromNative();
      checkLifecycleOrThrow(startEpoch, "queue load pending");
      // limit <= 0 表示一次性处理当前所有待处理片段
      const pending = await listPendingDiarySegments(limit > 0 ? limit : 10000);
      console.error(`[DiaryQueue] start run=${run.id} pending=${pending.length}`);

      // 片段之间互相独立：并发处理可显著缩短整体等待时间（上传/转写是主要耗时）
      let cursor = 0;
      const workerCount = Math.min(8, pending.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          const index = cursor;
          cursor += 1;
          if (index >= pending.length) return;
          run.lastActivityAt = Date.now();
          await processSegment(pending[index]);
        }
      }));
      console.error(`[DiaryQueue] done run=${run.id} processed=${processed} failed=${failed} deleted=${deleted}`);

      return { processed, failed, deleted, skipped: false };
    } finally {
      if (queueRun === run) queueRun = null;
    }
  })();

  processingPromise = runPromise;
  try {
    return await runPromise;
  } finally {
    if (processingPromise === runPromise) processingPromise = null;
  }
}

export async function processAllDiarySegments(): Promise<{ processed: number; failed: number; deleted: number; skipped: boolean }> {
  return processDiaryQueue(0);
}

export function cancelDiaryProcessing(): void {
  queueRun?.abort.abort();
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
        caveat: "来源仅供参考，不构成证据。",
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

      const finalNotes = boundedNotes || "No notes available. Return empty arrays.";
      // 大上下文下单次可送入几百 KB 笔记，超时时间随输入大小放宽
      const finalTimeoutMs = Math.min(240_000, 90_000 + Math.floor(textBytes(finalNotes) / 1000) * 500);
      let content: DailyDiaryContent | null = null;
      let validationError: Error | null = null;
      // 模型偶尔会漏写 sourceSegmentIds 或输出被截断，校验失败时补一次纠正重试
      for (let attempt = 0; attempt < 2 && !content; attempt += 1) {
        const correction = validationError
          ? (/截断/.test(validationError.message)
            ? "\n\nYour previous output was truncated. Return a much shorter strict JSON with at most 4 timeline entries, 4 topics, 2 commitments and 2 unresolved items."
            : `\n\nYour previous JSON failed validation: ${validationError.message}. Every non-empty timeline/topic/commitment/unresolved item must include at least one sourceSegmentIds entry copied exactly from the [[SRC:...]] labels above. Return strict JSON only.`)
          : "";
        let finalRaw: string;
        try {
          finalRaw = await callLLM(
            DAILY_SYSTEM,
            `${budgets.finalUserPrefix}${finalNotes}${correction}`,
            undefined,
            budgets.finalOutputTokens,
            true,
            { signal: linked.signal, timeoutMs: finalTimeoutMs },
          );
        } catch (error: any) {
          const message = error instanceof Error ? error.message : String(error ?? "");
          if (/截断/.test(message)) {
            validationError = new Error("模型输出被截断");
            continue;
          }
          throw error;
        }
        checkAbort(linked.signal);
        try {
          const candidate = normalizeContent(safeParseJson(finalRaw));
          validateNeutralDailyContent(candidate);
          validateSources(candidate, retainedSourceIds);
          content = candidate;
        } catch (error: any) {
          validationError = error instanceof Error ? error : new Error(String(error));
        }
      }
      if (!content) throw validationError ?? new Error("日记内容校验失败");
      checkLifecycleOrThrow(startEpoch, `daily generation ${localDate} after final`);
      await checkConsentOrThrow(`daily generation ${localDate} after final`);

      let saved: DailyDiary | null = null;
      try {
        await saveDailyDiary(
          localDate,
          {
            notes: boundedNotes,
            sourceSegmentIds: retainedSourceIds,
            content,
          },
          draftVersion,
        );
        saved = await getDailyDiary(localDate);
      } catch (error: any) {
        // 生成期间有片段完成转写会把日记版本号抬高：保留本次内容并标记待更新，避免整篇失败
        if (/version changed during generation/i.test(String(error?.message ?? ""))) {
          await saveDailyDiary(localDate, {
            notes: boundedNotes,
            sourceSegmentIds: retainedSourceIds,
            content,
          });
          await markDayDirty(localDate, "late-transcript");
          saved = await getDailyDiary(localDate);
        } else {
          throw error;
        }
      }
      if (!saved) throw new Error("Daily diary save failed");
      return saved;
    } catch (error: any) {
      if (!isAbortError(error)) {
        console.error(`[DiaryGen] ${localDate} failed: ${error?.message ?? error}`);
        await markDailyDiaryFailed(localDate, error?.message ?? "日记生成失败");
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

let lastQueueWaitLogAt = 0;

export async function handleDiaryForeground(): Promise<void> {
  try {
    await assertLifecycleOpen("foreground processing");
    const settings = await getDiarySettings();
    if (!settings.consentGranted) return;
    // 每次触发都把当前待处理队列一次清空；已有处理在跑时不重复导入和抢占
    if (queueRun) {
      const idleMs = Date.now() - queueRun.lastActivityAt;
      if (idleMs < STALE_RUN_MS) {
        const now = Date.now();
        if (now - lastQueueWaitLogAt > 60_000) {
          lastQueueWaitLogAt = now;
          console.error(`[DiaryQueue] skip run=${queueRun.id} idle=${Math.round(idleMs / 1000)}s inflight=${queueRun.inFlight}`);
        }
        return;
      }
      console.error(`[DiaryQueue] stale run=${queueRun.id} idle=${Math.round(idleMs / 1000)}s, taking over`);
    }
    // processDiaryQueue 内部会导入一次，这里不再重复导入
    await requeueRetryableFailedSegments(3).catch(() => {});
    const result = await processDiaryQueue(0);
    if (!result.skipped) {
      await autoApplyRetention().catch(() => {});
    }
  } catch (error: any) {
    console.error(`[DiaryQueue] trigger blocked: ${error?.message ?? error}`);
  }
}

async function requeueRetryableFailedSegments(maxRetryCount: number): Promise<void> {
  // 只读失败片段需要的字段，避免把全部片段的转写/笔记读进内存
  const failed = await listFailedDiarySegments();
  for (const item of failed) {
    // 原始音频已经不存在，重试也不可能成功，直接清理
    if (/音频文件不存在|audio_file_not_found/i.test(item.lastError)) {
      await deleteMeaninglessSegment(item).catch(() => {});
      continue;
    }
    if (item.retryCount >= maxRetryCount) continue;
    // 保留转写检查点（重试无需重新上传），但清除旧笔记以应用最新的中性化提示词
    await deleteProcessingCheckpoints(segmentNotesScope(item.id));
    await markSegmentState(item.id, "pending", "");
  }
}

function localDateOf(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

let lastAutoDailyAttemptMs = 0;
let autoDailyRunning = false;

// 跨天后自动生成前一天的每日日记；应用不在运行时无法定时，启动/回前台时补跑
export async function autoUpdateDailyDiary(): Promise<void> {
  if (!isSupportedPlatform() || autoDailyRunning) return;
  const settings = await getDiarySettings();
  if (!settings.consentGranted) return;
  const now = new Date();
  const target = localDateOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const existing = await getDailyDiary(target);
  if (existing?.state === "ready") return;
  // 失败后 10 分钟内不重复请求，避免网络故障时反复轰炸模型
  if (Date.now() - lastAutoDailyAttemptMs < 10 * 60 * 1000) return;
  lastAutoDailyAttemptMs = Date.now();
  autoDailyRunning = true;
  try {
    await generateDailyDiary(target);
  } catch {
    // 自动更新失败不阻塞其他维护任务，用户仍可手动更新
  } finally {
    autoDailyRunning = false;
  }
}

export async function startVoiceEnrollmentCapture(): Promise<void> {
  await assertLifecycleOpen("start enrollment");
  if (!isSupportedPlatform()) throw new Error(platformMessage());
  if (enrollmentActive) throw new Error("声纹录入已在进行中");
  if (isRecordingActive()) throw new Error("当前有其他录音正在进行");
  const started = await startRecording();
  if (started.simulated) {
    await cleanupRecording();
    throw new Error("声纹录入需要真实麦克风录音");
  }
  enrollmentActive = true;
}

export async function finishVoiceEnrollmentCapture(): Promise<{ durationMs: number }> {
  await assertLifecycleOpen("finish enrollment");
  if (!enrollmentActive) throw new Error("声纹录入未开始");
  enrollmentActive = false;
  let uri = "";
  let durationMs = 0;
  try {
    const result = await stopRecording();
    uri = result.uri;
    durationMs = result.durationMs;
    if (durationMs < 15000 || durationMs > 30000) {
      throw new Error("声纹样本需在 15-30 秒之间");
    }
    const native = await getNative();
    if (!native) throw new Error(platformMessage());
    try {
      await native.enrollSpeaker(uri);
    } catch (error: any) {
      const raw = String(error?.message ?? "");
      if (raw.includes("enroll_not_clean_solo_speech")) {
        throw new Error("录音内容不一致：请在安静环境下由同一个人连续说话 15-30 秒后重试");
      }
      if (raw.includes("enroll_insufficient_windows")) {
        throw new Error("有效语音太短：请连续说话 15 秒以上");
      }
      if (raw.includes("enroll_too_short")) {
        throw new Error("录音不足 15 秒，请重新录入");
      }
      if (raw.includes("enroll_too_long")) {
        throw new Error("录音超过 30 秒，请重新录入");
      }
      throw error;
    }
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
    if (status.active) throw new Error("日记采集进行中，暂不能执行保留清理");
    const plan = await planRetentionCleanup();

    const native = await getNative();
    const deleted: string[] = [];
    const blocked: string[] = [];
    const forced: string[] = [];

    // 已转写成功的片段：只删音频，保留转写文本与每日日记
    for (const id of plan.deletableSegmentIds) {
      try {
        if (native) await native.deleteDiarySegment(id);
        await markSegmentAudioDeleted(id);
        deleted.push(id);
      } catch {
        blocked.push(id);
      }
    }

    // 强制清理未处理片段：音频与记录一并删除
    if (options.allowUnprocessedDelete) {
      for (const id of plan.blockedUnprocessedSegmentIds) {
        const segment = await getDiarySegment(id);
        await clearSegmentCheckpoints(id, !!segment?.filePath);
        try {
          if (native) await native.deleteDiarySegment(id);
          deleted.push(id);
          forced.push(id);
        } catch {
          blocked.push(id);
        }
      }
      await deleteSegmentsByIds(forced);
      const dirtyDates = new Set<string>();
      for (const id of forced) {
        const segment = await getDiarySegment(id);
        if (segment) dirtyDates.add(segment.localDate);
      }
      for (const date of dirtyDates) {
        await markDayDirty(date, "retention-delete", true);
      }
    }

    return { deleted, blocked };
  });
}

// 前台时自动执行：仅清理已转写成功且超过保留期的音频
export async function autoApplyRetention(): Promise<void> {
  const status = await getNativeStatusOrDefault();
  if (status.active) return;
  const plan = await planRetentionCleanup();
  if (!plan.deletableSegmentIds.length) return;
  await applyRetentionPlan({ allowUnprocessedDelete: false });
}

export async function purgeDiaryData(includeDerived: boolean): Promise<void> {
  await withLifecycleMutation("purging-diary-data", async () => {
    await deleteProcessingCheckpoints("diary:", true);
    await cancelAndDrainDiaryWorkers();

    const status = await getNativeStatusOrDefault();
    if (status.active) throw new Error("Stop diary capture before deleting diary data");

    const native = await getNative();
    const allSegmentIds = new Set(await listDiarySegmentIds());

    if (native) {
      // 分页收集原生片段 ID；先收集再删除，避免边删边分页导致偏移错位漏删
      const nativeIds: string[] = [];
      let offset = 0;
      const PAGE_SIZE = 300;
      while (true) {
        const page = await native.listDiarySegmentsPage(offset, PAGE_SIZE);
        if (!page.length) break;
        for (const segment of page) {
          allSegmentIds.add(segment.id);
          nativeIds.push(segment.id);
        }
        offset += page.length;
        if (page.length < PAGE_SIZE) break;
      }
      for (const id of nativeIds) {
        try {
          await native.deleteDiarySegment(id);
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
