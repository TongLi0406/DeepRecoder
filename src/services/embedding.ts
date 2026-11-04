import { Platform } from "react-native";
import { debugLog } from "./debug";
import { postJson } from "./nativeHttp";

const SILICONFLOW_URL = "https://api.siliconflow.cn/v1/embeddings";
const SF_KEY_STORAGE = "siliconflow_api_key";
const SF_SEEDED_STORAGE = "siliconflow_api_key_seeded";

// 首次启动写入的默认 SiliconFlow 密钥（用户可在设置中修改或删除）
const DEFAULT_SF_KEY = "sk-ecirzdqmbmndpaxbqotvaxcgffwmtddliddvywrefcuznezc";

let sfKeyCache: string | null = null;

export async function getSiliconFlowKey(): Promise<string | null> {
  if (sfKeyCache) return sfKeyCache;
  if (Platform.OS === "web") {
    try { sfKeyCache = localStorage.getItem(SF_KEY_STORAGE); } catch {}
  } else {
    try {
      const SecureStore = await import("expo-secure-store");
      sfKeyCache = await SecureStore.getItemAsync(SF_KEY_STORAGE);
    } catch {}
  }
  return sfKeyCache;
}

export async function saveSiliconFlowKey(key: string): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.setItem(SF_KEY_STORAGE, key);
  } else {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(SF_KEY_STORAGE, key);
  }
  sfKeyCache = key;
}

export async function deleteSiliconFlowKey(): Promise<void> {
  if (Platform.OS === "web") {
    localStorage.removeItem(SF_KEY_STORAGE);
    localStorage.setItem(SF_SEEDED_STORAGE, "deleted");
  } else {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.deleteItemAsync(SF_KEY_STORAGE);
    await SecureStore.setItemAsync(SF_SEEDED_STORAGE, "deleted");
  }
  sfKeyCache = null;
}

export async function hasSiliconFlowKey(): Promise<boolean> {
  return (await getSiliconFlowKey()) !== null;
}

// 每次启动检查：密钥缺失且用户未主动删除时补回默认密钥
export async function seedDefaultSiliconFlowKey(): Promise<void> {
  let seeded: string | null = null;
  if (Platform.OS === "web") {
    try { seeded = localStorage.getItem(SF_SEEDED_STORAGE); } catch {}
  } else {
    try {
      const SecureStore = await import("expo-secure-store");
      seeded = await SecureStore.getItemAsync(SF_SEEDED_STORAGE);
    } catch {}
  }
  if (seeded === "deleted") return;
  if (await getSiliconFlowKey()) return;

  await saveSiliconFlowKey(DEFAULT_SF_KEY);
  if (Platform.OS === "web") {
    localStorage.setItem(SF_SEEDED_STORAGE, "1");
  } else {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(SF_SEEDED_STORAGE, "1");
  }
}

export async function testSiliconFlowConnection(apiKey: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await postJson(
      SILICONFLOW_URL,
      { Authorization: `Bearer ${apiKey}` },
      JSON.stringify({ model: "BAAI/bge-large-zh-v1.5", input: "connection test" }),
      15000,
    );
    if (res.status < 200 || res.status >= 300) return { ok: false, detail: `HTTP ${res.status}` };
    const data = JSON.parse(res.body || "{}");
    return data?.data?.[0]?.embedding?.length > 0
      ? { ok: true }
      : { ok: false, detail: "响应中没有向量数据" };
  } catch (error: any) {
    const aborted = error?.name === "AbortError";
    return { ok: false, detail: aborted ? "请求超时" : (error?.message ?? "网络请求失败") };
  }
}

// ── Primary: SiliconFlow BAAI/bge-large-zh-v1.5 ──

async function embedWithSiliconFlow(text: string): Promise<number[]> {
  const key = await getSiliconFlowKey();
  if (!key) throw new Error("未配置 SiliconFlow API 密钥");

  const res = await postJson(
    SILICONFLOW_URL,
    { Authorization: `Bearer ${key}` },
    JSON.stringify({ model: "BAAI/bge-large-zh-v1.5", input: text }),
    30000,
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`SiliconFlow embedding failed: ${res.status}`);
  }
  const data = JSON.parse(res.body || "{}");
  return data?.data?.[0]?.embedding;
}

// ── Fallback: DeepSeek LLM-based (128-dim, low quality) ──

async function embedWithDeepSeek(text: string): Promise<number[]> {
  const { callLLM, getApiKey } = await import("./api");
  const key = (await getApiKey()) ?? undefined;

  const raw = await callLLM(
    "将文本编码为数字列表。只返回 JSON 数组格式的128个浮点数，不要其他内容。",
    `将以下文本编码为128维嵌入向量，只返回JSON数字数组：\n\n${text}`,
    key,
    1024,
  );

  const match = raw.match(/\[[\d\s,.\-e+]+\]/);
  if (!match) throw new Error("Could not parse DeepSeek embedding");
  return JSON.parse(match[0]);
}

// ── Public API ──

let lastEmbeddingMethod = "";

export function getLastEmbeddingMethod(): string {
  return lastEmbeddingMethod;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const textPreview = text.slice(0, 50);
  debugLog(`[Embedding] Generating embedding for: "${textPreview}..."`);

  // Try SiliconFlow BGE first
  try {
    debugLog('[Embedding] Trying SiliconFlow BGE...');
    const emb = await embedWithSiliconFlow(text);
    if (emb && emb.length > 0) {
      lastEmbeddingMethod = "SiliconFlow BGE";
      debugLog(`[Embedding] SiliconFlow BGE success: ${emb.length}-dim vector`);
      return emb;
    }
  } catch (e: any) {
    debugLog(`[Embedding] SiliconFlow failed: ${e?.message || e}, falling back to DeepSeek`);
  }

  // Fallback to DeepSeek LLM-based embedding
  debugLog('[Embedding] Using DeepSeek LLM fallback...');
  lastEmbeddingMethod = "DeepSeek LLM";
  try {
    const result = await embedWithDeepSeek(text);
    debugLog(`[Embedding] DeepSeek LLM success: ${result.length}-dim vector`);
    return result;
  } catch (e: any) {
    debugLog(`[Embedding] DeepSeek fallback also failed: ${e?.message || e}`);
    throw e;
  }
}
