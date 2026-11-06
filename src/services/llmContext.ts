import { Buffer } from "buffer";

// 默认按模型最大上下文（1M tokens）配置；请求预算校验也以此为上限
export const DEFAULT_CONTEXT_LIMIT = 1_000_000;
export const TEXT_BUDGET = 6000;
// 每日日记的中间笔记上限：上下文已提升到 1M，单次可送入更多笔记，尽量一轮直出、减少归并轮次
export const DIARY_NOTES_BUDGET = 250_000;

export function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Processing aborted");
}

export function splitText(text: string, maxBytes = TEXT_BUDGET): string[] {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error("Invalid text budget");
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  for (const character of text) {
    const bytes = textBytes(character);
    if (size + bytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += character;
    size += bytes;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function compactText(
  text: string,
  reduce: (chunk: string) => Promise<string>,
  maxBytes = TEXT_BUDGET,
  signal?: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  splitText("", maxBytes);
  let current = text;
  while (textBytes(current) > maxBytes) {
    const outputs: string[] = [];
    for (const chunk of splitText(current, maxBytes)) {
      checkAbort(signal);
      const output = (await reduce(chunk)).trim();
      checkAbort(signal);
      if (!output || textBytes(output) > maxBytes) {
        throw new Error("Reduction output is empty or exceeds its budget");
      }
      outputs.push(output);
    }
    const next = outputs.join("\n\n");
    if (textBytes(next) >= textBytes(current)) {
      throw new Error("Reduction did not shrink; original text remains saved");
    }
    current = next;
  }
  return current;
}

export function assertRequestBudget(system: string, user: string, output: number, context = DEFAULT_CONTEXT_LIMIT): void {
  if (!Number.isInteger(output) || output < 1 || !Number.isInteger(context) || context < 1024) {
    throw new Error("Invalid model token limits");
  }
  if (textBytes(system) + textBytes(user) + output + 1024 > context) {
    throw new Error("Request exceeds model context budget; split or reduce its input first");
  }
}
