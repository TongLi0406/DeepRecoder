import { Platform } from "react-native";

let Audio: any = null;
let FileSystem: any = null;
let recording: any = null;
let transcript = "";
let simulationTimer: ReturnType<typeof setInterval> | null = null;
let simulationStart = 0;

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

// ─── Native Audio ───

async function ensureNativeAudio() {
  if (!Audio) {
    Audio = (await import("expo-av")).Audio;
  }
  return Audio;
}

async function ensureNativeFS() {
  if (!FileSystem) {
    FileSystem = await import("expo-file-system");
  }
  return FileSystem;
}

// ─── Public API ───

export async function startRecording(): Promise<{ simulated: boolean }> {
  transcript = "";

  if (Platform.OS === "web") {
    // Try real MediaRecorder first
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
        recording = { mediaRecorder, chunks, stream };
        startWebSpeech();
        return { simulated: false };
      } catch {
        // Fall through to simulation
      }
    }

    // Simulation mode — mic unavailable (HTTP, blocked, or no permission)
    simulationStart = Date.now();
    simulationTimer = setInterval(() => {}, 1000);
    recording = { simulated: true };
    transcript = "";
    return { simulated: true };
  }

  const audio = await ensureNativeAudio();
  const fs = await ensureNativeFS();
  await audio.requestPermissionsAsync();
  await audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
  });

  const { recording: rec } = await audio.Recording.createAsync({
    ...audio.RecordingOptionsPresets.HIGH_QUALITY,
    isMeteringEnabled: true,
  });
  recording = rec;
  return { simulated: false };
}

export async function stopRecording(): Promise<{ uri: string; durationMs: number; transcript: string; simulated: boolean }> {
  if (!recording) throw new Error("No active recording");

  if (Platform.OS === "web" && recording.simulated) {
    if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
    const durationMs = Date.now() - simulationStart;
    recording = null;
    return { uri: "", durationMs, transcript, simulated: true };
  }

  if (Platform.OS === "web") {
    const { mediaRecorder, chunks, stream } = recording;
    const capturedTranscript = stopWebSpeech();
    return new Promise((resolve) => {
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "audio/webm" });
        const url = URL.createObjectURL(blob);
        stream.getTracks().forEach((t: any) => t.stop());
        recording = null;
        resolve({ uri: url, durationMs: 0, transcript: capturedTranscript, simulated: false });
      };
      mediaRecorder.stop();
    });
  }

  const audio = await ensureNativeAudio();
  await recording.stopAndUnloadAsync();
  const srcUri = recording.getURI();
  const status = await recording.getStatusAsync();
  const durationMs = (status as any).durationMillis ?? 0;

  if (!srcUri) throw new Error("Recording URI not available");

  recording = null;
  return { uri: srcUri, durationMs, transcript: "", simulated: false };
}

export function getCurrentTranscript(): string {
  return transcript;
}

export async function pauseRecording(): Promise<void> {
  if (!recording) return;
  if (Platform.OS === "web") {
    if (recording.simulated) {
      if (simulationTimer) { clearInterval(simulationTimer); simulationTimer = null; }
      return;
    }
    recording.mediaRecorder.pause();
    if (speechRecognition) {
      try { speechRecognition.stop(); } catch { /* ignore */ }
    }
    return;
  }
  await recording.pauseAsync();
}

export async function resumeRecording(): Promise<void> {
  if (!recording) return;
  if (Platform.OS === "web") {
    if (recording.simulated) {
      simulationTimer = setInterval(() => {}, 1000);
      return;
    }
    recording.mediaRecorder.resume();
    if (speechRecognition) {
      try { speechRecognition.start(); } catch { /* ignore */ }
    }
    return;
  }
  await recording.startAsync();
}

export function isRecordingActive(): boolean {
  return recording !== null;
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
  if (recording) {
    try {
      if (Platform.OS === "web") {
        if (recording.simulated) {
          // nothing to clean up
        } else {
          recording.mediaRecorder.stop();
          recording.stream.getTracks().forEach((t: any) => t.stop());
        }
      } else {
        await recording.stopAndUnloadAsync();
      }
    } catch {
      // already stopped
    }
    recording = null;
  }
  transcript = "";
}

export async function getRecordingFileSize(uri: string): Promise<number> {
  if (Platform.OS === "web") return 0;
  try {
    const fs = await ensureNativeFS();
    const file = new fs.File(uri);
    return file.size ?? 0;
  } catch {
    return 0;
  }
}

export async function deleteFile(uri: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const fs = await ensureNativeFS();
    const file = new fs.File(uri);
    if (file.exists) file.delete();
  } catch {
    // file may not exist
  }
}
