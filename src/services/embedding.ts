import { Platform } from "react-native";
import { debugLog } from "./debug";

const SILICONFLOW_URL = "https://api.siliconflow.cn/v1/embeddings";
const SF_KEY_STORAGE = "siliconflow_api_key";

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
  sfKeyCache = key;
  if (Platform.OS === "web") {
    try { localStorage.setItem(SF_KEY_STORAGE, key); } catch {}
  } else {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.setItemAsync(SF_KEY_STORAGE, key);
  }
}

export async function deleteSiliconFlowKey(): Promise<void> {
  sfKeyCache = null;
  if (Platform.OS === "web") {
    try { localStorage.removeItem(SF_KEY_STORAGE); } catch {}
  } else {
    const SecureStore = await import("expo-secure-store");
    await SecureStore.deleteItemAsync(SF_KEY_STORAGE);
  }
}

export async function hasSiliconFlowKey(): Promise<boolean> {
  return (await getSiliconFlowKey()) !== null;
}

export async function testSiliconFlowConnection(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(SILICONFLOW_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "BAAI/bge-large-zh-v1.5",
        input: "connection test",
      }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    return data?.data?.[0]?.embedding?.length > 0;
  } catch {
    return false;
  }
}

// ── Primary: SiliconFlow BAAI/bge-large-zh-v1.5 ──

async function embedWithSiliconFlow(text: string): Promise<number[]> {
  const key = await getSiliconFlowKey();
  if (!key) throw new Error("No SiliconFlow API key");

  const res = await fetch(SILICONFLOW_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "BAAI/bge-large-zh-v1.5",
      input: text,
    }),
  });

  if (!res.ok) {
    throw new Error(`SiliconFlow embedding failed: ${res.status}`);
  }

  const data = await res.json();
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
