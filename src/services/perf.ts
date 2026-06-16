// ─── Performance Instrumentation ───

interface TimingMark {
  label: string;
  startTime: number;
  endTime?: number;
  duration?: number;
}

class PerfMonitor {
  private marks = new Map<string, TimingMark>();
  private enabled = true;

  start(label: string): void {
    if (!this.enabled) return;
    this.marks.set(label, {
      label,
      startTime: Date.now(),
    });
  }

  end(label: string): number {
    if (!this.enabled) return 0;
    const mark = this.marks.get(label);
    if (!mark) return 0;

    mark.endTime = Date.now();
    mark.duration = mark.endTime - mark.startTime;
    return mark.duration;
  }

  measure<T>(label: string, fn: () => T | Promise<T>): T | Promise<T> {
    this.start(label);
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.then(
          (value) => {
            this.end(label);
            return value;
          },
          (err) => {
            this.end(label);
            throw err;
          },
        );
      }
      this.end(label);
      return result;
    } catch (err) {
      this.end(label);
      throw err;
    }
  }

  getDuration(label: string): number {
    return this.marks.get(label)?.duration ?? 0;
  }

  getAllDurations(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [label, mark] of this.marks) {
      if (mark.duration !== undefined) {
        result[label] = mark.duration;
      }
    }
    return result;
  }

  // Report on SLA compliance
  checkSla(): SlaReport {
    const coldStart = this.getDuration("app:mount");
    const homeRender = this.getDuration("screen:home");
    const recordingStart = this.getDuration("recording:start");

    return {
      coldStartOk: coldStart <= 2000,
      homeRenderOk: homeRender <= 500,
      coldStartMs: coldStart,
      homeRenderMs: homeRender,
      recordingStartMs: recordingStart,
    };
  }
}

export interface SlaReport {
  coldStartOk: boolean;
  homeRenderOk: boolean;
  coldStartMs: number;
  homeRenderMs: number;
  recordingStartMs: number;
}

export const perf = new PerfMonitor();

// ─── Memory Monitor ───

export function estimateMemoryUsage(): number {
  // On React Native, we can't directly measure JS heap.
  // We track approximate load through vector embeddings count.
  // In a production app, this would use Performance API or native modules.
  return 0;
}

// ─── Consolidation Timer ───

export function checkConsolidationTime(
  skillCount: number,
  durationMs: number,
): boolean {
  // SLA: <5 seconds for 1000 skills
  const maxMs = 5000;
  const ok = durationMs <= maxMs;

  if (!ok) {
    console.warn(
      `[Perf] Consolidation of ${skillCount} skills took ${durationMs}ms ` +
      `(target: <${maxMs}ms)`,
    );
  }

  return ok;
}

// ─── App Startup Instrumentation ───

let appStartTime = performanceNow();

export function markAppStart(): void {
  appStartTime = performanceNow();
  perf.start("app:mount");
}

export function markAppReady(): void {
  perf.end("app:mount");
}

export function getAppStartTime(): number {
  return perf.getDuration("app:mount");
}

export function performanceNow(): number {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}
