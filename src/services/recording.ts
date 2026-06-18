import { Platform } from "react-native";

let AudioModule: any = null;
let RecordingPresets: any = null;
let requestPermissions: any = null;
let setAudioMode: any = null;
let recorder: any = null;
let transcript = "";
let simulationTimer: ReturnType<typeof setInterval> | null = null;
let simulationStart = 0;
let recordingStartTime = 0;

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
        recordingStartTime = Date.now();
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

  // Use PcmRecorder for native recording (produces valid WAV for whisper.rn)
  try {
    const { PcmRecorder } = await import("../../modules/pcm-recorder/src");
    const hasPerm = PcmRecorder.hasPermission();
    if (!hasPerm) {
      // Request permission via expo-audio
      await requestPermissions();
    }
    const status = await PcmRecorder.startRecording({
      sampleRate: 16000,
      enableMetering: false,
    });
    recorder = { pcmRecorder: PcmRecorder, filePath: status.filePath, simulated: false };
  } catch (e: any) {
    // Fallback to expo-audio if PcmRecorder fails
    console.warn("[Recording] PcmRecorder failed, falling back to expo-audio:", e?.message);
    await ensureNativeAudio();
    await requestPermissions();
    await setAudioMode({ allowsRecording: true, playsInSilentMode: true });
    recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
    await recorder.prepareToRecordAsync(RecordingPresets.HIGH_QUALITY);
    recorder.record();
  }

  // Start speech recognition (non-blocking — recording proceeds either way)
  startNativeSTT();

  return { simulated: false };
}

export async function stopRecording(elapsedSeconds?: number): Promise<{ uri: string; durationMs: number; transcript: string; simulated: boolean }> {
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
        resolve({ uri: url, durationMs: Date.now() - recordingStartTime, transcript: capturedTranscript, simulated: false });
      };
      mediaRecorder.stop();
    });
  }

  await stopNativeSTT();

  // Handle PcmRecorder (native WAV recording)
  if (recorder?.pcmRecorder) {
    const status = await recorder.pcmRecorder.stopRecording();
    const uri = status.filePath ?? "";
    const durationMs = elapsedSeconds ? elapsedSeconds * 1000 : status.durationMs;
    let capturedTranscript = transcript;
    recorder = null;

    // Try Whisper transcription
    if (!capturedTranscript && uri) {
      try {
        const { transcribeWithWhisper } = await import("./whisper");
        sttStatus = "active";
        sttError = null;
        capturedTranscript = await transcribeWithWhisper(uri);
        transcript = capturedTranscript;
      } catch (e: any) {
        sttStatus = "error";
        sttError = `Whisper failed: ${e?.message ?? "unknown"}`;
      }
    }

    return { uri, durationMs, transcript: capturedTranscript, simulated: false };
  }

  // Fallback to expo-audio
  await recorder.stop();
  const uri = recorder.uri ?? "";
  const durationMs = elapsedSeconds ? elapsedSeconds * 1000 : 0;
  let capturedTranscript = transcript;
  recorder = null;

  // Fallback: if native STT got no transcript, try Whisper
  if (!capturedTranscript && uri) {
    console.log("[Recording] No transcript, trying Whisper...");
    try {
      const { transcribeWithWhisper } = await import("./whisper");
      sttStatus = "active";
      sttError = null;
      console.log("[Recording] Calling whisper with uri:", uri);
      capturedTranscript = await transcribeWithWhisper(uri);
      console.log("[Recording] Whisper result length:", capturedTranscript?.length);
      transcript = capturedTranscript;
    } catch (e: any) {
      console.error("[Recording] Whisper failed:", e?.message);
      sttStatus = "error";
      sttError = `Whisper failed: ${e?.message ?? "unknown"}`;
    }
  } else if (capturedTranscript) {
    console.log("[Recording] Already have transcript from native STT");
  } else {
    console.log("[Recording] No uri, skipping whisper");
  }

  return { uri, durationMs, transcript: capturedTranscript, simulated: false };
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
  await recorder.pause();
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
