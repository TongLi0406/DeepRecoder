import { Platform } from "react-native";
import { debugLog } from "./debug";

const API_URL = "https://api.deepseek.com/anthropic/v1/messages";
const KEY_STORAGE_KEY = "api_key";

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
  try {
    localStorage.setItem(key, value);
  } catch {
    // localStorage may not be available
  }
}

function webDelete(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
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
): Promise<string> {
  const key = apiKey ?? (await getApiKey());
  if (!key) throw new Error("No API key configured");

  const body: Record<string, unknown> = {
    model: "deepseek-v4-pro",
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  };

  if (disableThinking) {
    body.thinking = { type: "disabled" };
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  const data = await res.json();

  debugLog(`[API] Thinking: ${disableThinking ? "OFF" : "ON"}, blocks: ${(data.content ?? []).map((b: any) => b.type).join(", ")}`);

  // Anthropic-compatible format: data.content[0].text
  // DeepSeek v4-pro may return both "thinking" and "text" blocks
  let textParts: string[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) {
      textParts.push(block.text);
    }
  }
  if (textParts.length > 0) return textParts.join("");

  // OpenAI-compatible format: data.choices[0].message.content
  const openaiText = data.choices?.[0]?.message?.content;
  if (openaiText) return openaiText;

  // Fallback: if only thinking blocks (DeepSeek v4-pro edge case), return thinking content
  let thinkingParts: string[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "thinking" && block.thinking) {
      thinkingParts.push(block.thinking);
    }
  }
  if (thinkingParts.length > 0) return thinkingParts.join("");

  throw new Error(`Unexpected API response: ${JSON.stringify(data).slice(0, 500)}`);
}

// ─── Test Connection ───

export async function testConnection(apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        max_tokens: 10,
        system: "Reply with just 'OK'.",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
