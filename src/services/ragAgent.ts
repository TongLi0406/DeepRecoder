import { callLLM } from "./api";
import { generateEmbedding } from "./embedding";
import { debugLog } from "./debug";
import {
  vectorSearch,
  keywordSearch,
  getAllEmbeddings,
  type SearchResult,
} from "./vectorStore";
import { getAllSessions } from "./storage";
import {
  searchSkillsByEmbedding,
  getDisplayGroup,
  SKILL_DISPLAY_GROUPS,
  type SkillDisplayGroup,
} from "./skills";
import type { Skill } from "../types";

// ─── Hybrid Search ───

export async function hybridSearch(
  query: string,
  topK = 5,
): Promise<SearchResult[]> {
  const allEmb = await getAllEmbeddings();

  if (allEmb.length === 0) return [];

  // Run semantic and keyword search in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    (async () => {
      const qEmb = await generateEmbedding(query);
      const results = await vectorSearch(qEmb, topK * 2);
      debugLog(`[HybridSearch] Semantic results: ${results.length} (top similarity: ${results[0]?.similarity?.toFixed(3) ?? 'N/A'})`);
      return results;
    })(),
    (async () => {
      const results = keywordSearch(allEmb, query).slice(0, topK * 2);
      debugLog(`[HybridSearch] Keyword results: ${results.length} (top score: ${results[0]?.similarity?.toFixed(3) ?? 'N/A'})`);
      return results;
    })(),
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
2. 如果提供了"思维框架"，用于组织你的回答结构，但不提供框架中没有的事实。
3. 每个回答后附上引用来源，格式：[来源: 内容片段]
4. 如果参考资料中有相互矛盾的信息，指出矛盾并给出两种观点。
5. 回答简洁直接，使用中文。`;

export interface MatchedSkillGroup {
  group: SkillDisplayGroup;
  skills: { skill: Skill; similarity: number }[];
}

export interface AgentResponse {
  answer: string;
  sources: string[];
  grounded: boolean;
  matchedSkillGroup?: MatchedSkillGroup;
}

export async function askAgent(
  question: string,
  sessionIds?: string[],
  apiKey?: string,
): Promise<AgentResponse> {
  // Step 1: Generate query embedding (shared by both searches)
  const qEmb = await generateEmbedding(question);

  // Step 2: Hybrid search + Skill search in parallel
  const [ragResults, skillResults] = await Promise.all([
    (async () => {
      const allEmb = await getAllEmbeddings();
      if (allEmb.length === 0) return [] as SearchResult[];

      const [semanticResults, keywordResults] = await Promise.all([
        vectorSearch(qEmb, 10),
        Promise.resolve(keywordSearch(allEmb, question).slice(0, 10)),
      ]);

      // RRF merge
      const scored = new Map<string, number>();
      const details = new Map<string, SearchResult>();
      const k = 60;
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
        .slice(0, 5)
        .map(([id]) => details.get(id)!);
    })(),
    searchSkillsByEmbedding(qEmb, 10),
  ]);

  debugLog(`[RAG] Searching for: "${question}"`);
  debugLog(`[RAG] Found ${ragResults.length} RAG results, ${skillResults.length} skills`);

  // Step 3: Select best display group for skills
  let matchedSkillGroup: MatchedSkillGroup | undefined;
  if (skillResults.length > 0) {
    // Group skills by display group, compute average similarity per group
    const groupStats = new Map<string, { group: SkillDisplayGroup; skills: typeof skillResults; totalSim: number }>();
    for (const sr of skillResults) {
      const g = getDisplayGroup(sr.skill.category);
      if (!g) continue;
      const existing = groupStats.get(g.key);
      if (existing) {
        existing.skills.push(sr);
        existing.totalSim += sr.similarity;
      } else {
        groupStats.set(g.key, { group: g, skills: [sr], totalSim: sr.similarity });
      }
    }

    // Pick group with highest average similarity
    let bestAvg = 0;
    let bestGroup: typeof groupStats extends Map<string, infer T> ? T | undefined : never;
    for (const [, stats] of groupStats) {
      const avg = stats.totalSim / stats.skills.length;
      if (avg > bestAvg) { bestAvg = avg; bestGroup = stats; }
    }

    if (bestGroup && bestAvg >= 0.5) {
      bestGroup.skills.sort((a, b) => b.similarity - a.similarity);
      matchedSkillGroup = {
        group: bestGroup.group,
        skills: bestGroup.skills.slice(0, 3),
      };
      // Increment use count for matched skills
      const { incrementUseCount } = await import("./skills");
      for (const s of matchedSkillGroup.skills) {
        incrementUseCount(s.skill.id).catch(() => {});
      }
      debugLog(`[RAG] Best skill group: ${bestGroup.group.label} (avg sim: ${bestAvg.toFixed(3)}, ${bestGroup.skills.length} skills)`);
    }
  }

  // Handle no results
  if (ragResults.length === 0) {
    return {
      answer: "知识库中还没有相关内容。请先录制并处理一些会议或课程。",
      sources: [],
      grounded: true,
      matchedSkillGroup,
    };
  }

  // Filter to session scope if provided
  const relevant = sessionIds
    ? ragResults.filter((r) => sessionIds.includes(r.embeddingRow.sessionId))
    : ragResults;

  if (relevant.length === 0) {
    return {
      answer: "在当前范围内没有找到相关信息。",
      sources: [],
      grounded: true,
      matchedSkillGroup,
    };
  }

  // Step 4: Build context
  const sources: string[] = relevant.map(
    (r) => `[${r.embeddingRow.contentType}] ${r.embeddingRow.contentText}`,
  );

  const context = relevant
    .map(
      (r, i) =>
        `[${i + 1}] 类型: ${r.embeddingRow.contentType} | 内容: ${r.embeddingRow.contentText}`,
    )
    .join("\n");

  // Session context
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

  // Step 5: Build skill framework for LLM prompt
  let skillFramework = "";
  if (matchedSkillGroup) {
    const skillLines = matchedSkillGroup.skills.map(
      (s) => `- [${s.skill.name}] ${s.skill.description}`,
    );
    skillFramework = `\n\n思维框架（${matchedSkillGroup.group.label}）：\n${skillLines.join("\n")}\n\n请参考以上思维框架组织你的回答结构，但事实内容只来自参考资料。`;
  }

  // Step 6: Generate answer
  const userMessage = `参考资料：
${context}

相关会话：
${sessionContext}${skillFramework}

用户问题：${question}

请基于参考资料回答。如果答案不在参考资料中，明确说明。附上引用来源。`;

  const raw = await callLLM(RAG_SYSTEM, userMessage, apiKey, 2048, false);

  const grounded = checkGrounded(raw, sources);
  debugLog(`[RAG] Answer (${raw.length} chars, grounded=${grounded}): ${raw.slice(0, 150)}...`);

  return { answer: raw, sources, grounded, matchedSkillGroup };
}

function checkGrounded(answer: string, sources: string[]): boolean {
  const lowerAnswer = answer.toLowerCase();

  if (
    lowerAnswer.includes("没有找到") ||
    lowerAnswer.includes("no information") ||
    lowerAnswer.includes("没有相关信息")
  ) {
    return true;
  }

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
  const terms: string[] = [];
  for (let i = 0; i < text.length - 2; i++) {
    const sub = text.slice(i, i + 3);
    if (/[一-鿿]{3}/.test(sub)) {
      terms.push(sub);
    }
  }
  return [...new Set(terms)].slice(0, 20);
}
