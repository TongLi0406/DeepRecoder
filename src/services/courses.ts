import { callLLM } from "./api";
import { generateEmbedding, getAllEmbeddings, cosineSim } from "./vectorStore";

// ─── Course Label Extraction ───

const COURSE_EXTRACT_SYSTEM = `你是一个课程分类助手。根据课堂内容提取课程名称。

输出 JSON：
{"courseName": "课程名称", "confidence": 0.0-1.0}`;

export async function extractCourseName(
  summary: any,
  apiKey?: string,
): Promise<{ courseName: string; confidence: number }> {
  const topic = summary.topic ?? "";
  const courseName = summary.courseName ?? "";
  const kps = summary.knowledgePoints?.map((kp: any) => kp.name).join("; ") ?? "";

  const content = `主题: ${topic}\n课程名: ${courseName}\n知识点: ${kps}`;

  const raw = await callLLM(
    COURSE_EXTRACT_SYSTEM,
    `提取这段课堂内容的课程名称：\n\n${content}`,
    apiKey,
    512,
  );

  try {
    const clean = raw.trim().replace(/```json\s*|```/g, "");
    const parsed = JSON.parse(clean);
    return {
      courseName: parsed.courseName ?? courseName ?? "Unknown Course",
      confidence: parsed.confidence ?? 0.5,
    };
  } catch {
    return { courseName: courseName ?? "Unknown Course", confidence: 0.5 };
  }
}

// ─── Course Matching ───

export async function findOrCreateCourse(
  candidateName: string,
  apiKey?: string,
): Promise<string> {
  const allEmb = await getAllEmbeddings();
  const courseEmb = allEmb.filter((e) => e.contentType === "course_label");

  if (courseEmb.length === 0) {
    // First course — create it
    const emb = await generateEmbedding(candidateName, apiKey);
    // Store as a special embedding (we'd need a dedicated table in production,
    // but for now we just return the name as-is)
    return candidateName;
  }

  // Compare against existing courses
  const candidateEmb = await generateEmbedding(candidateName, apiKey);
  let bestMatch: { name: string; similarity: number } | null = null;

  for (const existing of courseEmb) {
    const sim = cosineSim(candidateEmb, existing.embedding);
    if (sim > (bestMatch?.similarity ?? 0)) {
      bestMatch = { name: existing.contentText, similarity: sim };
    }
  }

  const THRESHOLD = 0.8;
  if (bestMatch && bestMatch.similarity >= THRESHOLD) {
    return bestMatch.name; // Assign to existing course
  }

  return candidateName; // New course
}

// ─── Course History Grouping ───

export interface CourseGroup {
  courseName: string;
  sessionCount: number;
  lastSessionDate: string;
  sessions: { id: string; date: string; topic: string }[];
}

export async function getCourseGroups(
  sessions: {
    id: string;
    courseName?: string;
    createdAt: string;
    summary?: any;
  }[],
): Promise<CourseGroup[]> {
  const map = new Map<string, CourseGroup>();

  for (const s of sessions) {
    const name = s.courseName ?? "Unclassified";
    if (!map.has(name)) {
      map.set(name, {
        courseName: name,
        sessionCount: 0,
        lastSessionDate: s.createdAt,
        sessions: [],
      });
    }
    const group = map.get(name)!;
    group.sessionCount++;
    group.sessions.push({
      id: s.id,
      date: s.createdAt,
      topic: (s as any).title ?? s.summary?.topic ?? s.summary?.title ?? "",
    });
    if (s.createdAt > group.lastSessionDate) {
      group.lastSessionDate = s.createdAt;
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.lastSessionDate.localeCompare(a.lastSessionDate),
  );
}
