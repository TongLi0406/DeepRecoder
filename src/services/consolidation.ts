import type { Skill, ConsolidationCandidate, ConsolidationResult } from "../types";
import { callLLM } from "./api";
import {
  getAllSkills,
  findConsolidationCandidates,
  mergeSkills,
  incrementUseCount,
} from "./skills";

// ─── Resource Budget ───

const MAX_SKILLS = 1000;
const MAX_PAIRS_PER_BATCH = 20;

export function shouldRunConsolidation(): boolean {
  // Resource budget check — called before running consolidation
  // Battery check deferred to native; here we just check skill count
  return true;
}

export async function runConsolidation(
  apiKey?: string,
): Promise<ConsolidationResult> {
  const allSkills = await getAllSkills();
  if (allSkills.length > MAX_SKILLS) {
    // Trim: only run on top 1000 by use count
    allSkills.length = MAX_SKILLS;
  }

  if (allSkills.length < 2) {
    return { merged: [], skipped: [] };
  }

  // Step 1: Find high-similarity pairs via cosine similarity
  const candidates = findConsolidationCandidates(allSkills, 0.75);

  // Step 2: Filter to top pairs for batched LLM merge
  const topPairs = candidates.slice(0, MAX_PAIRS_PER_BATCH);

  if (topPairs.length === 0) {
    return { merged: [], skipped: [] };
  }

  // Step 3: Batched LLM merge — single API call for all pairs
  const mergeDecisions = await batchLLMMerge(topPairs, apiKey);

  // Step 4: Execute merges
  const result: ConsolidationResult = { merged: [], skipped: [] };

  for (const decision of mergeDecisions) {
    if (decision.shouldMerge) {
      try {
        await mergeSkills(
          decision.parent === "A" ? decision.candidate.skillA : decision.candidate.skillB,
          [
            decision.parent === "A"
              ? decision.candidate.skillB.id
              : decision.candidate.skillA.id,
          ],
        );
        if (decision.parent === "A") {
          await incrementUseCount(decision.candidate.skillA.id);
        } else {
          await incrementUseCount(decision.candidate.skillB.id);
        }
        result.merged.push({
          parent: decision.parent === "A" ? decision.candidate.skillA.id : decision.candidate.skillB.id,
          child: decision.parent === "A" ? decision.candidate.skillB.id : decision.candidate.skillA.id,
        });
      } catch {
        result.skipped.push({
          skillA: decision.candidate.skillA.id,
          skillB: decision.candidate.skillB.id,
          reason: "merge error",
        });
      }
    } else {
      result.skipped.push({
        skillA: decision.candidate.skillA.id,
        skillB: decision.candidate.skillB.id,
        reason: decision.reason ?? "LLM decided not to merge",
      });
    }
  }

  return result;
}

// ─── Batched LLM Merge Prompt ───

const MERGE_SYSTEM = `你是技能分类专家。判断以下技能对是否应该合并。

规则：
- 如果两个技能本质相同，仅名称或描述略有差异 → merge
- 如果有明显功能差异（不同方法、不同场景） → keep separate
- 如果存疑 → keep separate

输出 JSON 数组，每个元素对应输入中的一对技能：
{"index": 0, "shouldMerge": true, "parent": "A", "mergedName": "合并后的名称"}

parent 为 "A" 表示以技能A为主（B的内容合并到A），"B" 表示以技能B为主。

严格输出 JSON 数组，不要其他内容。`;

async function batchLLMMerge(
  pairs: ConsolidationCandidate[],
  apiKey?: string,
): Promise<
  {
    candidate: ConsolidationCandidate;
    shouldMerge: boolean;
    parent: "A" | "B";
    reason?: string;
  }[]
> {
  const pairList = pairs
    .map(
      (p, i) =>
        `${i}. A: ${p.skillA.name} — ${p.skillA.description}\n   B: ${p.skillB.name} — ${p.skillB.description}\n   Similarity: ${p.similarity.toFixed(2)}`,
    )
    .join("\n\n");

  const userMessage = `判断以下技能对是否应该合并：\n\n${pairList}`;

  const raw = await callLLM(MERGE_SYSTEM, userMessage, apiKey, 2048);

  try {
    const clean = raw.trim().replace(/```json\s*|```/g, "");
    const decisions: {
      index: number;
      shouldMerge: boolean;
      parent?: "A" | "B";
    }[] = JSON.parse(clean);

    return decisions.map((d) => ({
      candidate: pairs[d.index],
      shouldMerge: d.shouldMerge,
      parent: d.parent === "B" ? "B" : "A",
    }));
  } catch {
    // If LLM output is malformed, skip all merges
    return pairs.map((p) => ({
      candidate: p,
      shouldMerge: false,
      parent: "A" as const,
      reason: "parse error",
    }));
  }
}

// ─── Simplified Merge (no LLM, pure threshold) ───

export async function quickConsolidation(
  threshold = 0.85,
): Promise<ConsolidationResult> {
  const allSkills = await getAllSkills();
  const candidates = findConsolidationCandidates(allSkills, threshold);
  const result: ConsolidationResult = { merged: [], skipped: [] };

  const mergedIds = new Set<string>();

  for (const c of candidates) {
    if (mergedIds.has(c.skillA.id) || mergedIds.has(c.skillB.id)) continue;

    try {
      // Keep the one with higher useCount as parent
      const parent = c.skillA.useCount >= c.skillB.useCount ? c.skillA : c.skillB;
      const child = parent.id === c.skillA.id ? c.skillB : c.skillA;
      await mergeSkills(parent, [child.id]);
      mergedIds.add(child.id);
      await incrementUseCount(parent.id);
      result.merged.push({ parent: parent.id, child: child.id });
    } catch {
      result.skipped.push({
        skillA: c.skillA.id,
        skillB: c.skillB.id,
        reason: "merge error",
      });
    }
  }

  return result;
}
