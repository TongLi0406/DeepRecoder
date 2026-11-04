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
  getSttStatus,
} from "../services/recording";
import { insertSession } from "../services/storage";
import { Mic, Pause, Play, Square, X } from "lucide-react-native";
import { colors, fonts, IconButton, RecordingPulse, ScreenHeader } from "../ui";

type Nav = NativeStackNavigationProp<RootStackParamList, "Recording">;
type Route = RouteProp<RootStackParamList, "Recording">;

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

const MODE_LABELS: Record<SessionMode, string> = {
  "meeting-organizer": "会议 · 主持人",
  "meeting-attendee": "会议 · 参会者",
  "classroom-student": "课堂 · 学生",
  "classroom-teacher": "课堂 · 教师",
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
  const [sttInfo, setSttInfo] = useState<{ status: string; error: string | null }>({ status: "idle", error: null });
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const autoStartConsumedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sttCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ownsRecordingRef = useRef(false);
  const pausedRef = useRef(false);
  const startTimeRef = useRef<string | null>(null);
  const elapsedRef = useRef(0);

  // Keep elapsedRef in sync
  useEffect(() => { elapsedRef.current = elapsed; }, [elapsed]);

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

  // Check STT status periodically during recording
  useEffect(() => {
    if (recording && !simulated) {
      sttCheckRef.current = setInterval(() => {
        setSttInfo(getSttStatus());
      }, 2000);
    } else {
      if (sttCheckRef.current) clearInterval(sttCheckRef.current);
    }
    return () => {
      if (sttCheckRef.current) clearInterval(sttCheckRef.current);
    };
  }, [recording, simulated]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (ownsRecordingRef.current) cleanupRecording().catch(() => {});
    };
  }, []);

  // Prevent back navigation while recording
  useEffect(() => {
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      if (!ownsRecordingRef.current && !startingRef.current) return;
      e.preventDefault();
      setError("请先停止录音再离开。");
    });
    return unsubscribe;
  }, [navigation]);

  const handleStart = useCallback(async () => {
    if (startingRef.current || ownsRecordingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    try {
      const result = await startRecording();
      startTimeRef.current = new Date().toISOString();
      ownsRecordingRef.current = true;
      if (!mountedRef.current) {
        await cleanupRecording();
        ownsRecordingRef.current = false;
        return;
      }
      pausedRef.current = false;
      if (Platform.OS !== "web") {
        try { (await import("react-native")).Vibration.vibrate(50); } catch { /* ok */ }
      }
      setSimulated(result.simulated);
      setRecording(true);
      setPaused(false);
      setElapsed(0);
    } catch (err: any) {
      if (mountedRef.current) setError(err.message ?? "无法开始录音");
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }, []);

  useEffect(() => {
    if (route.params.autoStart && !autoStartConsumedRef.current) {
      autoStartConsumedRef.current = true;
      void handleStart();
    }
  }, [route.params.autoStart, handleStart]);

  const handlePause = useCallback(async () => {
    try {
      if (pausedRef.current) {
        await resumeRecording();
        pausedRef.current = false;
        setPaused(false);
      } else {
        await pauseRecording();
        pausedRef.current = true;
        setPaused(true);
      }
    } catch {
      setError("暂停/继续录音失败");
    }
  }, []);

  const handleStop = useCallback(async () => {
    if (stopping) return;
    setStopping(true);
    setError(null);
    try {
      const { uri, durationMs, transcript: recTranscript } = await stopRecording(elapsedRef.current);
      ownsRecordingRef.current = false;
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
      setError(err.message ?? "无法停止录音");
    }
  }, [mode, navigation, stopping]);

  // Not started
  if (!recording) {
    return (
      <View style={styles.container}>
        <ScreenHeader title="录音" caption={MODE_LABELS[mode]} back />
        <View style={styles.center}>
          <TouchableOpacity
            style={styles.startButton}
            onPress={handleStart}
            accessibilityRole="button" accessibilityLabel="开始录音"
            disabled={stopping || starting}
          >
            <Mic size={30} color={colors.surface} />
          </TouchableOpacity>
          <Text style={styles.hint}>{starting ? "正在启动…" : "准备就绪"}</Text>
          {error && <Text style={styles.errorText}>{error}</Text>}
        </View>
        <View style={styles.cancelButton}><IconButton icon={X} label="取消录音" disabled={starting} onPress={() => navigation.goBack()} /></View>
      </View>
    );
  }

  // Recording in progress
  return (
    <View style={styles.container}>
      <View style={{ paddingTop: 32, paddingHorizontal: 24 }}>
        <Text style={{ fontFamily: fonts.strong, fontSize: 26, color: colors.text }}>{paused ? "已暂停" : "录音中"}</Text>
        <Text style={styles.modeLabel}>{MODE_LABELS[mode]}</Text>
      </View>

      {simulated && (
        <View style={styles.simBanner}>
          <Text style={styles.simBannerText}>
            模拟模式（麦克风不可用）
          </Text>
        </View>
      )}

      {!simulated && sttInfo.status === "whisper_pending" && (
        <View style={styles.sttBannerActive}>
          <Text style={styles.sttBannerTextActive}>
            录音结束后将由 Whisper 转写
          </Text>
        </View>
      )}

      {!simulated && sttInfo.status === "active" && (
        <View style={styles.sttBannerActive}>
          <Text style={styles.sttBannerTextActive}>
            语音识别进行中
          </Text>
        </View>
      )}

      <View style={styles.center}>
        <View style={{ width: 188, height: 188, alignItems: "center", justifyContent: "center" }}>
          <RecordingPulse active={!paused && !stopping && !simulated} />
          <Mic size={40} strokeWidth={1.4} color={paused ? colors.muted : colors.red} />
        </View>
        <Text style={styles.timer}>{formatTime(elapsed)}</Text>
        <Text style={styles.hint}>{stopping ? "正在保存…" : simulated ? "模拟录制" : paused ? "录制已暂停" : "麦克风工作中"}</Text>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <View style={styles.controls}>
          <IconButton icon={paused ? Play : Pause} label={paused ? "继续录音" : "暂停录音"} onPress={handlePause} disabled={stopping} />

          <TouchableOpacity
            style={[styles.stopButton, stopping && styles.stopButtonDisabled]}
            onPress={handleStop}
            disabled={stopping}
            accessibilityRole="button" accessibilityLabel="停止并保存录音"
            {...(Platform.OS === "web" ? { title: "停止并保存录音" } : {})}
          >
            <Square size={26} color={colors.surface} fill={colors.surface} />
          </TouchableOpacity>
          <View style={{ width: 44 }} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    width: "100%", maxWidth: 1040, alignSelf: "center",
    justifyContent: "space-between",
  },
  modeLabel: {
    color: colors.muted, fontFamily: fonts.body,
    fontSize: 13, marginTop: 8,
  },
  center: { flex: 1, justifyContent: "center", alignItems: "center", gap: 24 },
  startButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.red,
    justifyContent: "center",
    alignItems: "center",
  },
  startButtonInner: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: "#FFFFFF",
  },
  hint: { color: colors.muted, fontFamily: fonts.body, fontSize: 13 },
  errorText: {
    color: colors.red,
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  cancelButton: { alignItems: "center", paddingBottom: 24 },
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
  sttBanner: {
    backgroundColor: "rgba(234,67,53,0.15)",
    padding: 8,
    borderRadius: 8,
    marginTop: 8,
    alignItems: "center",
  },
  sttBannerError: {
    backgroundColor: "rgba(234,67,53,0.15)",
    padding: 8,
    borderRadius: 8,
    marginTop: 8,
    alignItems: "center",
  },
  sttBannerActive: {
    backgroundColor: "rgba(52,168,83,0.15)",
    padding: 8,
    borderRadius: 8,
    marginTop: 8,
    alignItems: "center",
  },
  sttBannerText: {
    color: "#EA4335",
    fontSize: 12,
    fontWeight: "500",
  },
  sttBannerTextActive: {
    color: "#34A853",
    fontSize: 12,
    fontWeight: "500",
  },
  timer: {
    color: colors.text,
    fontSize: 52,
    fontFamily: fonts.body,
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
