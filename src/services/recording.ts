import { Platform } from "react-native";

let AudioModule: any = null;
let RecordingPresets: any = null;
let requestPermissions: any = null;
let getPermissions: any = null;
let setAudioMode: any = null;
let recorder: any = null;
let transcript = "";
let simulationTimer: ReturnType<typeof setInterval> | null = null;
let simulationStart = 0;
let recordingStartTime = 0;
let lastKnownUri: string | null = null;
let pausedAtMs: number | null = null;
let pausedTotalMs = 0;

// ─── Lazy-load expo-audio (native only) ───

async function ensureNativeAudio() {
  if (!AudioModule) {
    const expoAudio = await import("expo-audio");
    AudioModule = expoAudio.AudioModule;
    RecordingPresets = expoAudio.RecordingPresets;
    requestPermissions = expoAudio.requestRecordingPermissionsAsync;
    getPermissions = expoAudio.getRecordingPermissionsAsync;
    setAudioMode = expoAudio.setAudioModeAsync;
  }
}

async function ensureRecordingPermission(): Promise<void> {
  await ensureNativeAudio();
  const current = await getPermissions();
  if (current?.granted) return;
  const requested = await requestPermissions();
  if (!requested?.granted) {
    throw new Error("Microphone permission denied");
  }
}

// ─── Native Speech Recognition ───

let sttModule: any = null;
let sttPartialSub: { remove: () => void } | null = null;
let sttFinalSub: { remove: () => void } | null = null;
let sttStatus: "idle" | "active" | "unavailable" | "error" | "whisper_pending" = "idle";
let sttError: string | null = null;

export function getSttStatus(): { status: string; error: string | null } {
  return { status: sttStatus, error: sttError };
}

async function ensureNativeSTT() {
  if (!sttModule) {
    sttModule = await import("react-native-speech-recognition-kit");
  }
}

function removeSttListeners() {
  if (sttPartialSub) { sttPartialSub.remove(); sttPartialSub = null; }
  if (sttFinalSub) { sttFinalSub.remove(); sttFinalSub = null; }
  if (sttModule) {
    try { sttModule.removeAllListeners("onSpeechPartialResults"); } catch {}
    try { sttModule.removeAllListeners("onSpeechResults"); } catch {}
  }
}

async function startNativeSTT() {
  // Skip native STT on all devices — use Whisper instead
  sttStatus = "whisper_pending";
  sttError = null;
  return;
}

async function stopNativeSTT() {
  // Native STT skipped — Whisper handles transcription
  removeSttListeners();
}

// ─── Web Speech Recognition ───

let speechRecognition: any = null;

function startWebSpeech(): void {
  transcript = "";
  const SpeechRecognition =
    (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  speechRecognition = new SpeechRecognition();
  speechRecognition.continuous = true;
  speechRecognition.interimResults = true;
  speechRecognition.lang = "zh-CN";

  speechRecognition.onresult = (event: any) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        transcript += event.results[i][0].transcript;
      }
    }
  };

  speechRecognition.onerror = () => {};
  speechRecognition.start();
}

function stopWebSpeech(): string {
  if (speechRecognition) {
    try { speechRecognition.stop(); } catch { /* ignore */ }
    speechRecognition = null;
  }
  return transcript;
}

// ─── Public API ───

export async function startRecording(): Promise<{ simulated: boolean }> {
  if (recorder) throw new Error("Another recording is already active");
  transcript = "";
  pausedAtMs = null;
  pausedTotalMs = 0;
  lastKnownUri = null;

  if (Platform.OS === "web") {
    const hasMedia = typeof navigator !== "undefined" && navigator.mediaDevices;
    if (hasMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new (window as any).MediaRecorder(stream, {
          mimeType: "audio/webm",
        });
        const chunks: Blob[] = [];
        mediaRecorder.ondataavailable = (e: any) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        mediaRecorder.start(1000);
        recorder = { mediaRecorder, chunks, stream, simulated: false };
        recordingStartTime = Date.now();
        startWebSpeech();
        return { simulated: false };
      } catch (e: any) {
        const msg = String(e?.message ?? "").toLowerCase();
        if (msg.includes("denied") || msg.includes("notallowed") || msg.includes("permission")) {
          throw new Error("Microphone permission denied");
        }
        const allowSimulation = typeof window !== "undefined" && !!(window as any).__RECORDER_ALLOW_WEB_SIMULATION__;
        if (!allowSimulation) {
          throw new Error("Web recording failed. Enable microphone access and retry.");
        }
      }
    }

    const allowSimulation = typeof window !== "undefined" && !!(window as any).__RECORDER_ALLOW_WEB_SIMULATION__;
    if (!allowSimulation) {
      throw new Error("Web recording requires MediaRecorder support");
    }
    simulationStart = Date.now();
    simulationTimer = setInterval(() => {}, 1000);
    recorder = { simulated: true };
    return { simulated: true };
  }

  if (Platform.OS === "android") {
    await ensureRecordingPermission();
    let PcmRecorder: any;
    try {
      ({ PcmRecorder } = await import("../../modules/pcm-recorder/src"));
    } catch {
      throw new Error("PCM recorder module unavailable. Use a custom development build on Android.");
    }
    const diaryStatus = typeof PcmRecorder.getDiaryStatus === "function" ? await PcmRecorder.getDiaryStatus() : { active: false };
    if (diaryStatus?.active) {
      throw new Error("Cannot start recording while diary capture is active");
    }
    if (!PcmRecorder.hasPermission()) {
      await ensureRecordingPermission();
      if (!PcmRecorder.hasPermission()) {
        throw new Error("Microphone permission denied");
      }
    }
    const status = await PcmRecorder.startRecording({ sampleRate: 16000, enableMetering: false });
    recorder = { kind: "pcm", pcmRecorder: PcmRecorder, filePath: status.filePath, simulated: false };
    lastKnownUri = status.filePath ?? null;
    startNativeSTT();
    return { simulated: false };
  }

  // iOS fallback keeps file under document directory (persistent storage)
  await ensureRecordingPermission();
  await setAudioMode({ allowsRecording: true, playsInSilentMode: true });
  const iosRecorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
  await iosRecorder.prepareToRecordAsync({ ...RecordingPresets.HIGH_QUALITY, directory: "document" });
  iosRecorder.record();
  recorder = { kind: "expo", expoRecorder: iosRecorder, simulated: false };
  startNativeSTT();

  return { simulated: false };
}

export async function stopRecording(elapsedSeconds?: number): Promise<{ uri: string; durationMs: number; transcript: string; simulated: boolean }> {
  if (!recorder) throw new Error("No active recording");

  if (Platform.OS === "web" && recorder.simulated) {
    if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
    const durationMs = Date.now() - simulationStart;
    recorder = null;
    pausedAtMs = null;
    pausedTotalMs = 0;
    return { uri: "", durationMs, transcript, simulated: true };
  }

  if (Platform.OS === "web") {
    const { mediaRecorder, chunks, stream } = recorder;
    const capturedTranscript = stopWebSpeech();
    return new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        stream.getTracks().forEach((t: any) => t.stop());
        recorder = null;
        const durationMs = Math.max(0, Date.now() - recordingStartTime - pausedTotalMs);
        pausedAtMs = null;
        pausedTotalMs = 0;
        lastKnownUri = url;
        resolve({ uri: url, durationMs, transcript: capturedTranscript, simulated: false });
      };
      mediaRecorder.stop();
    });
  }

  await stopNativeSTT();

  // Handle PcmRecorder (native WAV recording)
  if (recorder?.kind === "pcm") {
    const status = await recorder.pcmRecorder.stopRecording();
    const uri = status.filePath ?? recorder.filePath ?? "";
    if (!uri) throw new Error("PCM recorder returned empty file path");
    lastKnownUri = uri;
    recorder = null;
    pausedAtMs = null;
    pausedTotalMs = 0;
    return { uri, durationMs: status.durationMs ?? 0, transcript: "", simulated: false };
  }

  // iOS expo-audio path
  const activeExpoRecorder = recorder.expoRecorder;
  const statusBeforeStop = await activeExpoRecorder.getStatus();
  await activeExpoRecorder.stop();
  const uri = activeExpoRecorder.uri ?? "";
  if (!uri) throw new Error("Audio recorder returned empty file path");
  const durationMs = Math.max(0, Number(statusBeforeStop?.durationMillis ?? (elapsedSeconds ? elapsedSeconds * 1000 : 0)));
  lastKnownUri = uri;
  recorder = null;
  pausedAtMs = null;
  pausedTotalMs = 0;

  return { uri, durationMs, transcript: "", simulated: false };
}

export function getCurrentTranscript(): string {
  return transcript;
}

export async function pauseRecording(): Promise<void> {
  if (!recorder) return;
  if (Platform.OS === "web") {
    if (recorder.simulated) {
      if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
      return;
    }
    recorder.mediaRecorder.pause();
    pausedAtMs = Date.now();
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch { /* ignore */ }
    }
    return;
  }
  if (recorder.kind === "pcm") {
    await recorder.pcmRecorder.pauseRecording();
  } else {
    await recorder.expoRecorder.pause();
  }
  pausedAtMs = Date.now();
}

export async function resumeRecording(): Promise<void> {
  if (!recorder) return;
  if (Platform.OS === "web") {
    if (recorder.simulated) {
      simulationTimer = setInterval(() => {}, 1000);
      return;
    }
    recorder.mediaRecorder.resume();
    if (pausedAtMs) {
      pausedTotalMs += Date.now() - pausedAtMs;
      pausedAtMs = null;
    }
    if (speechRecognition) {
      try { speechRecognition.start(); } catch { /* ignore */ }
    }
    return;
  }
  if (pausedAtMs) {
    pausedTotalMs += Date.now() - pausedAtMs;
    pausedAtMs = null;
  }
  if (recorder.kind === "pcm") {
    await recorder.pcmRecorder.resumeRecording();
  } else {
    recorder.expoRecorder.record();
  }
}

export function isRecordingActive(): boolean {
  return recorder !== null;
}

export async function cleanupRecording(): Promise<void> {
  if (speechRecognition) {
    try { speechRecognition.stop(); } catch { /* ignore */ }
    speechRecognition = null;
  }
  removeSttListeners();
  if (sttModule) {
    try { await sttModule.stopListening(); } catch {}
    try { await sttModule.destroy(); } catch {}
    sttModule = null;
  }
  if (simulationTimer) {
    clearInterval(simulationTimer);
    simulationTimer = null;
  }
  if (recorder) {
    try {
      if (Platform.OS === "web") {
        if (!recorder.simulated) {
          recorder.mediaRecorder.stop();
          recorder.stream.getTracks().forEach((t: any) => t.stop());
        }
      } else {
        if (recorder.kind === "pcm") {
          await recorder.pcmRecorder.cancelRecording();
          if (recorder.filePath) {
            try { await recorder.pcmRecorder.deleteRecording(recorder.filePath); } catch {}
          }
        } else {
          await recorder.expoRecorder.stop();
          const uri = recorder.expoRecorder.uri;
          if (uri) {
            try { await deleteFile(uri); } catch {}
          }
        }
      }
    } catch {
      // already stopped
    }
    recorder = null;
  }
  pausedAtMs = null;
  pausedTotalMs = 0;
  transcript = "";
}

export async function getRecordingFileSize(uri: string): Promise<number> {
  if (Platform.OS === "web") return 0;
  try {
    const fs = await import("expo-file-system");
    const file = new fs.File(uri);
    return file.size ?? 0;
  } catch {
    return 0;
  }
}

export async function deleteFile(uri: string): Promise<void> {
  if (!uri) return;
  if (Platform.OS === "web") {
    if (uri.startsWith("blob:")) {
      URL.revokeObjectURL(uri);
    }
    return;
  }
  const fs = await import("expo-file-system");
  const file = new fs.File(uri);
  if (!file.exists) return;
  try {
    file.delete();
  } catch (e: any) {
    throw new Error(e?.message ?? "Failed to delete recording file");
  }
}
