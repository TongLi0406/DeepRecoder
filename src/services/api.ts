import { Platform } from "react-native";
import { debugLog } from "./debug";
import { assertRequestBudget, checkAbort, DEFAULT_CONTEXT_LIMIT } from "./llmContext";

const API_URL = "https://api.deepseek.com/anthropic/v1/messages";
const KEY_STORAGE_KEY = "api_key";
const KEY_SEEDED_STORAGE_KEY = "api_key_seeded";
const MODEL_STORAGE_KEY = "llm_model_config";

// 首次启动写入的默认密钥与模型（用户可在设置中修改或删除）
const DEFAULT_API_KEY = "sk-53c50605ed424977858f5d76bbe3174a";
const DEFAULT_MODEL = "deepseek-flash";

export interface ModelConfig {
  endpoint: string;
  model: string;
  contextLimit: number;
  format: "anthropic" | "openai";
}

export async function getModelConfig(): Promise<ModelConfig> {
  if (cachedModelConfig) return cachedModelConfig;
  const raw = isWeb ? webGet(MODEL_STORAGE_KEY) : await nativeGet(MODEL_STORAGE_KEY);
  const config = raw ? JSON.parse(raw) : {
    endpoint: API_URL, model: DEFAULT_MODEL, contextLimit: DEFAULT_CONTEXT_LIMIT, format: "anthropic",
  };
  validateModelConfig(config);
  cachedModelConfig = config;
  return config;
}

function validateModelConfig(config: ModelConfig): void {
  if (!config || typeof config.endpoint !== "string" || typeof config.model !== "string" ||
      !config.endpoint.startsWith("https://") || !config.model.trim() ||
      !["anthropic", "openai"].includes(config.format)) throw new Error("模型配置无效");
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.hash || config.contextLimit < 8192) throw new Error("请使用有效的 HTTPS 接口地址，且上下文长度至少为 8192");
  assertRequestBudget("", "", 4096, config.contextLimit);
}

export async function saveModelConfig(config: ModelConfig): Promise<void> {
  validateModelConfig(config);
  const raw = JSON.stringify({ ...config, endpoint: config.endpoint.trim(), model: config.model.trim() });
  cachedModelConfig = { ...config, endpoint: config.endpoint.trim(), model: config.model.trim() };
  if (isWeb) webSet(MODEL_STORAGE_KEY, raw);
  else await nativeSet(MODEL_STORAGE_KEY, raw);
}

export function parseLLMResponse(data: any): string {
  if (!data || typeof data !== "object") throw new Error("模型响应无效");
  const reason = data.stop_reason ?? data.choices?.[0]?.finish_reason;
  if (reason === "max_tokens" || reason === "length") throw new Error("模型输出被截断，请减少输出长度或提高输出上限");
  if (reason === "refusal" || reason === "content_filter") throw new Error("模型拒绝了该请求");
  const text = (Array.isArray(data.content) ? data.content : []).filter((block: any) => block?.type === "text")
    .map((block: any) => block.text ?? "").join("") || data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("模型未返回可用文本");
  return text;
}

// ─── Web-compatible Key Storage ───

async function nativeGet(key: string): Promise<string | null> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.getItemAsync(key);
}

async function nativeSet(key: string, value: string): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.setItemAsync(key, value);
}

async function nativeDelete(key: string): Promise<void> {
  const SecureStore = await import("expo-secure-store");
  return SecureStore.deleteItemAsync(key);
}

function webGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function webSet(key: string, value: string): void {
  localStorage.setItem(key, value);
}

function webDelete(key: string): void {
  localStorage.removeItem(key);
}

const isWeb = Platform.OS === "web";

// SecureStore 读取在部分设备上可达数百毫秒，模型配置与密钥需要缓存
let cachedModelConfig: ModelConfig | null = null;
let cachedApiKey: string | null | undefined;

export async function getApiKey(): Promise<string | null> {
  if (cachedApiKey !== undefined) return cachedApiKey;
  cachedApiKey = isWeb ? webGet(KEY_STORAGE_KEY) : await nativeGet(KEY_STORAGE_KEY);
  return cachedApiKey;
}

export async function saveApiKey(key: string): Promise<void> {
  cachedApiKey = key;
  if (isWeb) return webSet(KEY_STORAGE_KEY, key);
  return nativeSet(KEY_STORAGE_KEY, key);
}

export async function deleteApiKey(): Promise<void> {
  cachedApiKey = null;
  if (isWeb) { webDelete(KEY_STORAGE_KEY); webSet(KEY_SEEDED_STORAGE_KEY, "deleted"); return; }
  await nativeDelete(KEY_STORAGE_KEY);
  await nativeSet(KEY_SEEDED_STORAGE_KEY, "deleted");
}

// 仅首次启动时写入默认密钥，之后用户的修改/删除不会被覆盖
export async function seedDefaultApiKey(): Promise<void> {
  const seeded = isWeb ? webGet(KEY_SEEDED_STORAGE_KEY) : await nativeGet(KEY_SEEDED_STORAGE_KEY);
  if (seeded === "deleted") return;
  const existing = await getApiKey();
  if (!existing) {
    await saveApiKey(DEFAULT_API_KEY);
    if (isWeb) webSet(KEY_SEEDED_STORAGE_KEY, "1");
    else await nativeSet(KEY_SEEDED_STORAGE_KEY, "1");
  }
}

// ─── API Client ───

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callLLM(
  systemPrompt: string,
  userMessage: string,
  apiKey?: string,
  maxTokens = 4096,
  disableThinking = true,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  checkAbort(options.signal);
  const config = await getModelConfig();
  assertRequestBudget(systemPrompt, userMessage, maxTokens, config.contextLimit);
  const key = apiKey ?? (await getApiKey());
  if (!key) throw new Error("未配置 API 密钥");

  const body: Record<string, unknown> = config.format === "anthropic" ? {
    model: config.model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  } : {
    model: config.model, max_tokens: maxTokens,
    messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
  };

  if (disableThinking && config.format === "anthropic") {
    body.thinking = { type: "disabled" };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs ?? 90000);
  try {
  checkAbort(options.signal);
  const res = await fetch(config.endpoint, {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let code = "";
    try {
      const body = await res.json();
      const candidate = body?.error?.code;
      if (["context_length_exceeded", "insufficient_quota", "rate_limit_exceeded"].includes(candidate)) code = ` (${candidate})`;
    } catch {}
    throw new Error(`API 请求失败 ${res.status}${code}`);
  }

  const data = await res.json();
  checkAbort(options.signal);
  debugLog("[API] Response received");
  return parseLLMResponse(data);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.signal?.aborted ? "处理已中止" : "模型请求超时");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

// ─── Test Connection ───

export async function testConnection(apiKey: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    await callLLM("Reply with just 'OK'.", "ping", apiKey, 32, true, { timeoutMs: 12000 });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, detail: error?.message ?? "网络请求失败" };
  }
}
