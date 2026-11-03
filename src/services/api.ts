import { Platform } from "react-native";
import { debugLog } from "./debug";
import { assertRequestBudget, checkAbort, DEFAULT_CONTEXT_LIMIT } from "./llmContext";

const API_URL = "https://api.deepseek.com/anthropic/v1/messages";
const KEY_STORAGE_KEY = "api_key";
const MODEL_STORAGE_KEY = "llm_model_config";

export interface ModelConfig {
  endpoint: string;
  model: string;
  contextLimit: number;
  format: "anthropic" | "openai";
}

export async function getModelConfig(): Promise<ModelConfig> {
  const raw = isWeb ? webGet(MODEL_STORAGE_KEY) : await nativeGet(MODEL_STORAGE_KEY);
  const config = raw ? JSON.parse(raw) : {
    endpoint: API_URL, model: "deepseek-v4-pro", contextLimit: DEFAULT_CONTEXT_LIMIT, format: "anthropic",
  };
  validateModelConfig(config);
  return config;
}

function validateModelConfig(config: ModelConfig): void {
  if (!config || typeof config.endpoint !== "string" || typeof config.model !== "string" ||
      !config.endpoint.startsWith("https://") || !config.model.trim() ||
      !["anthropic", "openai"].includes(config.format)) throw new Error("Invalid model configuration");
  const url = new URL(config.endpoint);
  if (url.username || url.password || url.hash || config.contextLimit < 8192) throw new Error("Use a valid HTTPS endpoint and a context limit of at least 8192");
  assertRequestBudget("", "", 4096, config.contextLimit);
}

export async function saveModelConfig(config: ModelConfig): Promise<void> {
  validateModelConfig(config);
  const raw = JSON.stringify({ ...config, endpoint: config.endpoint.trim(), model: config.model.trim() });
  if (isWeb) webSet(MODEL_STORAGE_KEY, raw);
  else await nativeSet(MODEL_STORAGE_KEY, raw);
}

export function parseLLMResponse(data: any): string {
  if (!data || typeof data !== "object") throw new Error("Invalid model response");
  const reason = data.stop_reason ?? data.choices?.[0]?.finish_reason;
  if (reason === "max_tokens" || reason === "length") throw new Error("Model output truncated; reduce output size or increase its budget");
  if (reason === "refusal" || reason === "content_filter") throw new Error("Model declined this request");
  const text = (Array.isArray(data.content) ? data.content : []).filter((block: any) => block?.type === "text")
    .map((block: any) => block.text ?? "").join("") || data.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("Model returned no usable text output");
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

export async function getApiKey(): Promise<string | null> {
  if (isWeb) return webGet(KEY_STORAGE_KEY);
  return nativeGet(KEY_STORAGE_KEY);
}

export async function saveApiKey(key: string): Promise<void> {
  if (isWeb) return webSet(KEY_STORAGE_KEY, key);
  return nativeSet(KEY_STORAGE_KEY, key);
}

export async function deleteApiKey(): Promise<void> {
  if (isWeb) return webDelete(KEY_STORAGE_KEY);
  return nativeDelete(KEY_STORAGE_KEY);
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
  if (!key) throw new Error("No API key configured");

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
    throw new Error(`API error ${res.status}${code}`);
  }

  const data = await res.json();
  checkAbort(options.signal);
  debugLog("[API] Response received");
  return parseLLMResponse(data);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(options.signal?.aborted ? "Processing aborted" : "Model request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

// ─── Test Connection ───

export async function testConnection(apiKey: string): Promise<boolean> {
  try {
    await callLLM("Reply with just 'OK'.", "ping", apiKey, 32);
    return true;
  } catch {
    return false;
  }
}
