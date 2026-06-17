import { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { SessionMode, Session } from "../types";
import { getSampleSummary } from "../services/sampleData";

type Nav = NativeStackNavigationProp<RootStackParamList, "Main">;

const MODES: { key: SessionMode; title: string; desc: string; icon: string }[] =
  [
    {
      key: "meeting-organizer",
      title: "Meeting — Organizer",
      desc: "Decisions, action items, owners, timeline",
      icon: "📋",
    },
    {
      key: "meeting-attendee",
      title: "Meeting — Attendee",
      desc: "What matters to me, my action items, key decisions",
      icon: "✏️",
    },
    {
      key: "classroom-student",
      title: "Classroom — Student",
      desc: "Knowledge points, problem-solving methods, lesson links",
      icon: "📖",
    },
    {
      key: "classroom-teacher",
      title: "Classroom — Teacher",
      desc: "Teaching style, engagement, question analysis, suggestions",
      icon: "📊",
    },
  ];

export default function HomeScreen() {
  const navigation = useNavigation<Nav>();
  const [selectedMode, setSelectedMode] = useState<SessionMode | null>(null);

  const handleStart = useCallback(() => {
    if (selectedMode) {
      navigation.navigate("Recording", { mode: selectedMode });
    }
  }, [selectedMode, navigation]);

  const handleDemo = useCallback(() => {
    const mode = selectedMode ?? "classroom-student";
    const session: Session = {
      id: "sample-" + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      mode,
      phase: "done",
      audioUri: "",
      audioDuration: 0,
      summary: getSampleSummary(mode),
    };
    navigation.navigate("Summary", { session });
  }, [selectedMode, navigation]);

  const handleRealTest = useCallback(() => {
    const mode = selectedMode ?? "classroom-student";
    if (!mode.startsWith("classroom")) {
      Alert.alert("Info", "Real transcript test is only available for classroom modes.");
      return;
    }
    const REAL_TRANSCRIPT = `如果你的二常屬壓軸體只能做第一問，那麼這個視頻就有可能是你歷天改命的唯一機會。二常屬壓軸體是整個初中裡面公認最難的考題。我把整個初中二常屬壓軸體的所有考點全部給你輸你出來了，從基礎的面積問題，套路性的存在性問題，到難倒一片的幾何三大變化，甚至是讓人頭皮發麻的新定義問題。今天只要把這個視頻吃透，二常屬拉滿合不再是一個遙不可及的夢想。我們來看第一，一支拋物線y等於x方與直線y等於-2x加上如圖所示，第一問求焦點AB的坐標，求焦點坐標直接連立解方程就可以了。解第一問，拋物線解析式是y等於x平方，一常屬解析式是y等於-2x加上，連立解方程可以算出x1等於1x2等於-3，所以說A點坐標是3鬥-9，B點坐標是1鬥1。第二問求三角形AB的面積，A點坐標B點坐標O點坐標都已經固定下了，所以說三角形AB的形狀已經固定，解決一個形狀固定的三角形面積，我們常用兩種方式，要么割要么薄，那麼這地方建議大家直接割。`;
    const session: Session = {
      id: "real-test-" + Date.now().toString(36),
      createdAt: new Date().toISOString(),
      endTime: new Date(Date.now() + 300000).toISOString(),
      mode,
      phase: "recording",
      audioUri: "",
      audioDuration: 300000,
      transcript: REAL_TRANSCRIPT,
    };
    navigation.navigate("Summary", { session });
  }, [selectedMode, navigation]);

  const handleWhisperTest = useCallback(async () => {
    if (Platform.OS === "web") {
      Alert.alert("Not Available", "Whisper only works on native (Android/iOS). Use the web demo instead.");
      return;
    }
    try {
      const { initWhisper } = await import("../services/whisper");
      Alert.alert("Whisper", "Initializing bundled Whisper model...");
      const ok = await initWhisper();
      if (!ok) {
        Alert.alert("Whisper", "Failed to initialize. Check network and try again.");
        return;
      }
      Alert.alert("Whisper", "Model loaded! Record something to test auto-transcription.");
    } catch (e: any) {
      Alert.alert("Whisper Error", e?.message ?? "Unknown error");
    }
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Recorder</Text>
      <Text style={styles.subtitle}>One-tap meeting & classroom intelligence</Text>

      <Text style={styles.sectionTitle}>Choose Mode</Text>
      <View style={styles.modeGrid}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m.key}
            style={[styles.modeCard, selectedMode === m.key && styles.modeCardSelected]}
            onPress={() => setSelectedMode(m.key)}
          >
            <Text style={styles.modeIcon}>{m.icon}</Text>
            <Text style={styles.modeTitle}>{m.title}</Text>
            <Text style={styles.modeDesc}>{m.desc}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity
        style={[styles.recordButton, !selectedMode && styles.recordButtonDisabled]}
        onPress={handleStart}
        disabled={!selectedMode}
      >
        <Text style={styles.recordButtonText}>
          {selectedMode ? "Start Recording" : "Select a mode above"}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.demoButton} onPress={handleDemo}>
        <Text style={styles.demoButtonText}>Try with sample audio</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.realTestButton} onPress={handleRealTest}>
        <Text style={styles.realTestButtonText}>Test with real transcript (LLM)</Text>
      </TouchableOpacity>

      {Platform.OS !== "web" && (
        <TouchableOpacity style={styles.whisperButton} onPress={handleWhisperTest}>
          <Text style={styles.whisperButtonText}>Test Whisper (local STT)</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { padding: 24, paddingTop: 60, paddingBottom: 40 },
  title: { fontSize: 32, fontWeight: "700", color: "#1A1A1A" },
  subtitle: { fontSize: 15, color: "#5F6368", marginTop: 4, marginBottom: 32 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: "#1A1A1A", marginBottom: 16 },
  modeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  modeCard: {
    width: "47%",
    backgroundColor: "#F8F9FA",
    borderRadius: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: "transparent",
  },
  modeCardSelected: { borderColor: "#1A73E8", backgroundColor: "#E8F0FE" },
  modeIcon: { fontSize: 24, marginBottom: 8 },
  modeTitle: { fontSize: 14, fontWeight: "600", color: "#1A1A1A" },
  modeDesc: { fontSize: 12, color: "#5F6368", marginTop: 4, lineHeight: 16 },
  recordButton: {
    marginTop: 32,
    backgroundColor: "#1A73E8",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  recordButtonDisabled: { backgroundColor: "#DADCE0" },
  recordButtonText: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
  demoButton: {
    marginTop: 16,
    alignItems: "center",
    paddingVertical: 12,
  },
  demoButtonText: { color: "#1A73E8", fontSize: 15 },
  realTestButton: {
    marginTop: 8,
    alignItems: "center",
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#34A853",
    borderRadius: 10,
  },
  realTestButtonText: { color: "#34A853", fontSize: 15, fontWeight: "500" },
  whisperButton: {
    marginTop: 8,
    alignItems: "center",
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: "#9334E6",
    borderRadius: 10,
  },
  whisperButtonText: { color: "#9334E6", fontSize: 15, fontWeight: "500" },
});
