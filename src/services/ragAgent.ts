import { callLLM } from "./api";
import {
  generateEmbedding,
  vectorSearch,
  keywordSearch,
  getAllEmbeddings,
  type SearchResult,
} from "./vectorStore";
import { getAllSessions } from "./storage";
import type { Session } from "../types";

// ─── Hybrid Search ───

export async function hybridSearch(
  query: string,
  topK = 5,
  apiKey?: string,
): Promise<SearchResult[]> {
  const allEmb = await getAllEmbeddings();

  if (allEmb.length === 0) return [];

  // Run semantic and keyword search in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    (async () => {
      const qEmb = await generateEmbedding(query, apiKey);
      return vectorSearch(qEmb, topK * 2);
    })(),
    Promise.resolve(keywordSearch(allEmb, query).slice(0, topK * 2)),
  ]);

  // Merge with reciprocal rank fusion
  const scored = new Map<string, number>();
  const details = new Map<string, SearchResult>();

  const k = 60; // RRF constant
  for (let rank = 0; rank < semanticResults.length; rank++) {
    const r = semanticResults[rank];
    scored.set(r.embeddingRow.id, (scored.get(r.embeddingRow.id) ?? 0) + 1 / (k + rank + 1));
    details.set(r.embeddingRow.id, r);
  }
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    scored.set(r.embeddingRow.id, (scored.get(r.embeddingRow.id) ?? 0) + 1 / (k + rank + 1));
    if (!details.has(r.embeddingRow.id)) details.set(r.embeddingRow.id, r);
  }

  return Array.from(scored.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([id]) => details.get(id)!);
}

// ─── RAG Agent ───

const RAG_SYSTEM = `你是一个知识库问答助手。基于提供的上下文内容回答用户问题。

规则：
1. 只基于下方"参考资料"中的内容回答。如果答案不在参考资料中，说"我在知识库中没有找到相关信息"——不要猜测或编造。
2. 每个回答后附上引用来源，格式：[来源: 内容片段]
3. 如果参考资料中有相互矛盾的信息，指出矛盾并给出两种观点。
4. 回答简洁直接，使用中文。`;

export interface AgentResponse {
  answer: string;
  sources: string[];
  grounded: boolean;
}

export async function askAgent(
  question: string,
  sessionIds?: string[],
  apiKey?: string,
): Promise<AgentResponse> {
  // Step 1: Hybrid search for relevant content
  const results = await hybridSearch(question, 5, apiKey);

  if (results.length === 0) {
    return {
      answer: "知识库中还没有相关内容。请先录制并处理一些会议或课程。",
      sources: [],
      grounded: true,
    };
  }

  // Filter to session scope if provided
  const relevant = sessionIds
    ? results.filter((r) => sessionIds.includes(r.embeddingRow.sessionId))
    : results;

  if (relevant.length === 0) {
    return {
      answer: "在当前范围内没有找到相关信息。",
      sources: [],
      grounded: true,
    };
  }

  // Step 2: Build context from retrieved embeddings
  const sources: string[] = relevant.map(
    (r) => `[${r.embeddingRow.contentType}] ${r.embeddingRow.contentText}`,
  );

  const context = relevant
    .map(
      (r, i) =>
        `[${i + 1}] 类型: ${r.embeddingRow.contentType} | 内容: ${r.embeddingRow.contentText}`,
    )
    .join("\n");

  // Step 3: Get session info for richer context
  const allSessions = await getAllSessions();
  const sessionMap = new Map(allSessions.map((s) => [s.id, s]));

  const sessionContext = [...new Set(relevant.map((r) => r.embeddingRow.sessionId))]
    .map((sid) => {
      const s = sessionMap.get(sid);
      if (!s) return "";
      return `会话 ${sid.slice(0, 6)}: ${s.mode} — ${s.courseName ?? "Unknown"}`;
    })
    .filter(Boolean)
    .join("\n");

  // Step 4: Generate answer
  const userMessage = `参考资料：
${context}

相关会话：
${sessionContext}

用户问题：${question}

请基于参考资料回答。如果答案不在参考资料中，明确说明。附上引用来源。`;

  const raw = await callLLM(RAG_SYSTEM, userMessage, apiKey, 2048);

  // Step 5: Basic hallucination check — verify key claims appear in sources
  const grounded = checkGrounded(raw, sources);

  return { answer: raw, sources, grounded };
}

function checkGrounded(answer: string, sources: string[]): boolean {
  // Simple heuristic: if the answer says "没有找到" or "no information",
  // it's grounded (honest). If it makes claims, check for source overlap.
  const lowerAnswer = answer.toLowerCase();

  if (
    lowerAnswer.includes("没有找到") ||
    lowerAnswer.includes("no information") ||
    lowerAnswer.includes("没有相关信息")
  ) {
    return true;
  }

  // Check if at least some key terms from sources appear in the answer
  const sourceText = sources.join(" ").toLowerCase();
  const keyTerms = extractKeyTerms(lowerAnswer);
  if (keyTerms.length === 0) return true;

  let matchedTerms = 0;
  for (const term of keyTerms) {
    if (sourceText.includes(term)) matchedTerms++;
  }

  return matchedTerms / keyTerms.length >= 0.3;
}

function extractKeyTerms(text: string): string[] {
  // Extract 3+ character Chinese words or phrases
  const terms: string[] = [];
  for (let i = 0; i < text.length - 2; i++) {
    const sub = text.slice(i, i + 3);
    if (/[一-鿿]{3}/.test(sub)) {
      terms.push(sub);
    }
  }
  return [...new Set(terms)].slice(0, 20);
}
