import { Platform } from "react-native";

let AudioModule: any = null;
let RecordingPresets: any = null;
let requestPermissions: any = null;
let setAudioMode: any = null;
let recorder: any = null;
let transcript = "";
let simulationTimer: ReturnType<typeof setInterval> | null = null;
let simulationStart = 0;

// ─── Lazy-load expo-audio (native only) ───

async function ensureNativeAudio() {
  if (!AudioModule) {
    const expoAudio = await import("expo-audio");
    AudioModule = expoAudio.AudioModule;
    RecordingPresets = expoAudio.RecordingPresets;
    requestPermissions = expoAudio.requestRecordingPermissionsAsync;
    setAudioMode = expoAudio.setAudioModeAsync;
  }
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
  transcript = "";

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
        startWebSpeech();
        return { simulated: false };
      } catch {
        // Fall through to simulation
      }
    }

    simulationStart = Date.now();
    simulationTimer = setInterval(() => {}, 1000);
    recorder = { simulated: true };
    return { simulated: true };
  }

  await ensureNativeAudio();

  await requestPermissions();
  await setAudioMode({
    allowsRecording: true,
    playsInSilentMode: true,
  });

  recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
  await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
  recorder.record();
  return { simulated: false };
}

export async function stopRecording(): Promise<{ uri: string; durationMs: number; transcript: string; simulated: boolean }> {
  if (!recorder) throw new Error("No active recording");

  if (Platform.OS === "web" && recorder.simulated) {
    if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
    const durationMs = Date.now() - simulationStart;
    recorder = null;
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
        resolve({ uri: url, durationMs: 0, transcript: capturedTranscript, simulated: false });
      };
      mediaRecorder.stop();
    });
  }

  await recorder.stop();
  const uri = recorder.uri ?? "";
  const durationMs = (recorder.currentTime ?? 0) * 1000;
  recorder = null;
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
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch { /* ignore */ }
    }
    return;
  }
  recorder.pause();
}

export async function resumeRecording(): Promise<void> {
  if (!recorder) return;
  if (Platform.OS === "web") {
    if (recorder.simulated) {
      simulationTimer = setInterval(() => {}, 1000);
      return;
    }
    recorder.mediaRecorder.resume();
    if (speechRecognition) {
      try { speechRecognition.start(); } catch { /* ignore */ }
    }
    return;
  }
  recorder.record();
}

export function isRecordingActive(): boolean {
  return recorder !== null;
}

export async function cleanupRecording(): Promise<void> {
  if (speechRecognition) {
    try { speechRecognition.stop(); } catch { /* ignore */ }
    speechRecognition = null;
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
        await recorder.stop();
      }
    } catch {
      // already stopped
    }
    recorder = null;
  }
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
  if (Platform.OS === "web") return;
  try {
    const fs = await import("expo-file-system");
    const file = new fs.File(uri);
    if (file.exists) file.delete();
  } catch {
    // file may not exist
  }
}
