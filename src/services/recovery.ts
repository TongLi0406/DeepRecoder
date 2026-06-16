import { Platform } from "react-native";
import { getAllSessions, updateSessionPhase } from "./storage";
import type { SessionPhase } from "../types";

// ─── Recording Recovery ───

export async function recoverOrphanRecordings(): Promise<string[]> {
  if (Platform.OS === "web") return [];
  try {
    const fs = await import("expo-file-system");
    const dir = new fs.Directory(fs.Paths.cache, "orphan_recordings");
    if (!dir.exists) return [];
    return dir.list().filter((f: any) => f.uri).map((f: any) => f.uri);
  } catch { return []; }
}

export async function cleanOrphans(): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const fs = await import("expo-file-system");
    const dir = new fs.Directory(fs.Paths.cache, "orphan_recordings");
    if (dir.exists) {
      for (const item of dir.list()) {
        if (item && typeof (item as any).delete === "function") (item as any).delete();
      }
    }
  } catch { /* ignore */ }
}

// ─── Session Checkpoint Recovery ───

export async function recoverInterruptedSessions(): Promise<void> {
  const sessions = await getAllSessions();

  for (const session of sessions) {
    if (session.phase === "transcribing" || session.phase === "summarizing") {
      await updateSessionPhase(session.id, "recording");
    }
    if (session.phase === "recording") {
      const age = Date.now() - new Date(session.createdAt).getTime();
      if (age > 86400000) {
        await updateSessionPhase(session.id, "failed", "Recording abandoned (24h timeout)");
      }
    }
  }
}

// ─── Disk Space ───

const LOW_SPACE_MB = 500;
let lastSpaceWarning = 0;

export async function checkDiskSpace(): Promise<{ ok: boolean; availableMB: number; warning?: string }> {
  if (Platform.OS === "web") return { ok: true, availableMB: 9999 };

  try {
    const fs = await import("expo-file-system");
    const available = fs.Paths.availableDiskSpace;
    const availableMB = Math.round(available / (1024 * 1024));

    if (available < LOW_SPACE_MB * 1024 * 1024) {
      const now = Date.now();
      if (now - lastSpaceWarning > 300000) {
        lastSpaceWarning = now;
        return { ok: false, availableMB, warning: `Low disk space: ${availableMB}MB. Free up space.` };
      }
      return { ok: false, availableMB };
    }
    return { ok: true, availableMB };
  } catch {
    return { ok: true, availableMB: 0 };
  }
}

// ─── API Error Helpers ───

export async function savePartialResults(sessionId: string, phase: SessionPhase, partialData: any, error: string): Promise<void> {
  await updateSessionPhase(sessionId, phase, error);
}

export function isCreditExhausted(errorMessage: string): boolean {
  const indicators = ["insufficient_quota", "rate_limit", "429", "quota exceeded", "余额不足", "充值", "billing", "credit"];
  return indicators.some((i) => errorMessage.toLowerCase().includes(i));
}

export async function handleCreditExhaustion(sessionId: string, partialData: any): Promise<void> {
  await savePartialResults(sessionId, "failed", partialData, "API credit exhausted — partial results saved");
}

export async function validateRecordingFile(uri: string): Promise<boolean> {
  if (Platform.OS === "web") return uri.startsWith("blob:");
  try {
    const fs = await import("expo-file-system");
    const file = new fs.File(uri);
    return file.exists && (file.size ?? 0) > 0;
  } catch { return false; }
}
