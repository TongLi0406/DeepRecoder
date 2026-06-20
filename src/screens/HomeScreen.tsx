import { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { SessionMode } from "../types";

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
});
