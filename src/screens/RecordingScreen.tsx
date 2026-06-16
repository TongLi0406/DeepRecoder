import { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Platform,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RouteProp } from "@react-navigation/native";
import type { RootStackParamList } from "../../App";
import type { SessionMode, Session } from "../types";
import {
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  cleanupRecording,
} from "../services/recording";
import { insertSession } from "../services/storage";

type Nav = NativeStackNavigationProp<RootStackParamList, "Recording">;
type Route = RouteProp<RootStackParamList, "Recording">;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const MODE_LABELS: Record<SessionMode, string> = {
  "meeting-organizer": "Meeting · Organizer",
  "meeting-attendee": "Meeting · Attendee",
  "classroom-student": "Classroom · Student",
  "classroom-teacher": "Classroom · Teacher",
};

export default function RecordingScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { mode } = route.params;

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [simulated, setSimulated] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingRef = useRef(false);
  const pausedRef = useRef(false);
  const startTimeRef = useRef<string | null>(null);

  // Timer
  useEffect(() => {
    if (recording && !paused) {
      timerRef.current = setInterval(() => setElapsed((v) => v + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [recording, paused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupRecording().catch(() => {});
    };
  }, []);

  // Prevent back navigation while recording
  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (!recordingRef.current) return;
      e.preventDefault();
      setError("Stop recording before leaving.");
    });
    return unsubscribe;
  }, [navigation]);

  const handleStart = useCallback(async () => {
    setError(null);
    try {
      const result = await startRecording();
      startTimeRef.current = new Date().toISOString();
      recordingRef.current = true;
      pausedRef.current = false;
      if (Platform.OS !== "web") {
        try { (await import("react-native")).Vibration.vibrate(50); } catch { /* ok */ }
      }
      setSimulated(result.simulated);
      setRecording(true);
      setPaused(false);
      setElapsed(0);
    } catch (err: any) {
      setError(err.message ?? "Could not start recording");
    }
  }, []);

  const handlePause = useCallback(async () => {
    try {
      if (pausedRef.current) {
        await resumeRecording();
        recordingRef.current = true;
        pausedRef.current = false;
        setPaused(false);
      } else {
        await pauseRecording();
        recordingRef.current = false;
        pausedRef.current = true;
        setPaused(true);
      }
    } catch {
      setError("Could not pause/resume recording");
    }
  }, []);

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      recordingRef.current = false;
      const { uri, durationMs, transcript: recTranscript } = await stopRecording();
      setRecording(false);

      const now = new Date().toISOString();
      const session: Session = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        createdAt: startTimeRef.current ?? now,
        endTime: now,
        mode,
        phase: "recording",
        audioUri: uri,
        audioDuration: durationMs,
        transcript: recTranscript || undefined,
      };

      await insertSession(session);
      navigation.replace("Summary", { session });
    } catch (err: any) {
      setStopping(false);
      setError(err.message ?? "Could not stop recording");
    }
  }, [mode, navigation, stopping]);

  // Not started
  if (!recording) {
    return (
      <View style={styles.container}>
        <Text style={styles.modeLabel}>{MODE_LABELS[mode]}</Text>
        <View style={styles.center}>
          <TouchableOpacity
            style={styles.startButton}
            onPress={handleStart}
            disabled={stopping}
          >
            <View style={styles.startButtonInner} />
          </TouchableOpacity>
          <Text style={styles.hint}>Tap to start recording</Text>
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => navigation.goBack()}
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Recording in progress
  return (
    <View style={styles.container}>
      <Text style={styles.modeLabel}>{MODE_LABELS[mode]}</Text>

      {simulated && (
        <View style={styles.simBanner}>
          <Text style={styles.simBannerText}>
            Simulation mode (mic unavailable)
          </Text>
        </View>
      )}

      <View style={styles.center}>
        <Text style={styles.timer}>{formatTime(elapsed)}</Text>

        <View style={styles.waveformPlaceholder}>
          <View style={styles.waveBar} />
          <View style={[styles.waveBar, { height: 16 }]} />
          <View style={[styles.waveBar, { height: 32, backgroundColor: paused ? "#F9AB00" : "#EA4335" }]} />
          <View style={[styles.waveBar, { height: 24 }]} />
          <View style={[styles.waveBar, { height: 20 }]} />
          <View style={[styles.waveBar, { height: 28 }]} />
          <View style={[styles.waveBar, { height: 12 }]} />
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <View style={styles.controls}>
          <TouchableOpacity style={styles.secondaryButton} onPress={handlePause}>
            <Text style={styles.secondaryButtonText}>
              {paused ? "Resume" : "Pause"}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.stopButton, stopping && styles.stopButtonDisabled]}
            onPress={handleStop}
            disabled={stopping}
          >
            <View style={styles.stopIcon} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Flag</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1A1A1A",
    padding: 24,
    paddingTop: 60,
    justifyContent: "space-between",
  },
  modeLabel: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    textAlign: "center",
  },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 24 },
  startButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#EA4335",
    justifyContent: "center",
    alignItems: "center",
  },
  startButtonInner: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: "#FFFFFF",
  },
  hint: { color: "rgba(255,255,255,0.5)", fontSize: 15 },
  errorText: {
    color: "#F28B82",
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  cancelButton: { alignItems: "center", paddingBottom: 20 },
  cancelButtonText: { color: "rgba(255,255,255,0.5)", fontSize: 15 },
  simBanner: {
    backgroundColor: "rgba(249,171,0,0.15)",
    padding: 8,
    borderRadius: 8,
    marginTop: 12,
    alignItems: "center",
  },
  simBannerText: {
    color: "#F9AB00",
    fontSize: 12,
    fontWeight: "500",
  },
  timer: {
    color: "#FFFFFF",
    fontSize: 48,
    fontWeight: "300",
    fontVariant: ["tabular-nums"],
  },
  waveformPlaceholder: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 3,
    height: 40,
  },
  waveBar: {
    width: 4,
    height: 8,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 32,
  },
  secondaryButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  secondaryButtonText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 14,
    fontWeight: "500",
  },
  stopButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#EA4335",
    justifyContent: "center",
    alignItems: "center",
  },
  stopButtonDisabled: { opacity: 0.5 },
  stopIcon: {
    width: 20,
    height: 20,
    borderRadius: 4,
    backgroundColor: "#FFFFFF",
  },
});
