import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import type { Skill, ConsolidationResult } from "../types";
import {
  getAllSkills,
  findConsolidationCandidates,
  CATEGORY_LABELS,
} from "../services/skills";
import { quickConsolidation } from "../services/consolidation";
import { skillsToHtml, skillsToMarkdown } from "../services/export";

export default function SkillsScreen() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [candidateCount, setCandidateCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [consolidating, setConsolidating] = useState(false);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    const all = await getAllSkills();
    setSkills(all);
    const candidates = await findConsolidationCandidates(all, 0.70);
    setCandidateCount(candidates.length);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleExport = useCallback(() => {
    if (skills.length === 0) return;
    Alert.alert("Export Skills", "Choose format:", [
      {
        text: "Markdown",
        onPress: async () => {
          try {
            const { writeAsStringAsync, documentDirectory } = await import("expo-file-system/legacy");
            const { shareAsync } = await import("expo-sharing");
            const md = skillsToMarkdown(skills);
            const fileUri = `${documentDirectory}skills_summary.md`;
            await writeAsStringAsync(fileUri, md, { encoding: "utf8" });
            await shareAsync(fileUri, { mimeType: "text/markdown" });
          } catch (e: any) {
            Alert.alert("Export failed", e.message);
          }
        },
      },
      {
        text: "PDF",
        onPress: async () => {
          try {
            const { printToFileAsync } = await import("expo-print");
            const { shareAsync } = await import("expo-sharing");
            const html = skillsToHtml(skills);
            const file = await printToFileAsync({ html, base64: false });
            await shareAsync(file.uri, { mimeType: "application/pdf" });
          } catch (e: any) {
            Alert.alert("Export failed", e.message);
          }
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [skills]);

  const handleConsolidate = useCallback(async () => {
    setConsolidating(true);
    try {
      const result: ConsolidationResult = await quickConsolidation(0.70);
      const msg =
        result.merged.length > 0
          ? `Merged ${result.merged.length} skill pairs. ${result.skipped.length} skipped.`
          : "No skills to merge yet. Record more sessions to build your skill library.";
      Alert.alert("Consolidation Complete", msg);
      await loadSkills();
    } catch (e: any) {
      Alert.alert("Error", e.message ?? "Consolidation failed");
    } finally {
      setConsolidating(false);
    }
  }, [loadSkills]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1A73E8" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Skills Summary</Text>
        <Text style={styles.subtitle}>
          跨会话提炼的解题方法、决策模式与沟通技巧 · {skills.length} 条
        </Text>
        {skills.length > 0 && (
          <TouchableOpacity style={styles.exportButton} onPress={handleExport}>
            <Text style={styles.exportButtonText}>Export</Text>
          </TouchableOpacity>
        )}
      </View>

      {candidateCount > 0 && (
        <TouchableOpacity
          style={[styles.consolidateButton, consolidating && styles.consolidateButtonDisabled]}
          onPress={handleConsolidate}
          disabled={consolidating}
        >
          {consolidating ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.consolidateButtonText}>
              Run Consolidation ({candidateCount} candidates)
            </Text>
          )}
        </TouchableOpacity>
      )}

      {skills.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🧩</Text>
          <Text style={styles.emptyText}>
            暂无已总结 Skill。录制并处理会话后自动提取。
          </Text>
        </View>
      ) : (
        <FlatList
          data={skills}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.skillCard}>
              <View style={styles.skillHeader}>
                <Text style={styles.skillName}>{item.name}</Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {CATEGORY_LABELS[item.category] ?? item.category}
                  </Text>
                </View>
              </View>
              <Text style={styles.skillDesc}>{item.description}</Text>
              <View style={styles.skillMeta}>
                <Text style={styles.metaText}>
                  Used {item.useCount}× · {item.sourceSessionIds.length} sessions
                </Text>
                {item.mergedFrom.length > 0 && (
                  <Text style={styles.mergedText}>
                    Merged from {item.mergedFrom.length} skills
                  </Text>
                )}
              </View>
            </View>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: { padding: 24, paddingTop: 60, paddingBottom: 12 },
  title: { fontSize: 32, fontWeight: "700", color: "#1A1A1A" },
  subtitle: { fontSize: 14, color: "#5F6368", marginTop: 4 },
  exportButton: {
    marginTop: 12,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: "#1A73E8",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  exportButtonText: { color: "#1A73E8", fontSize: 13, fontWeight: "500" },
  consolidateButton: {
    marginHorizontal: 24,
    marginBottom: 16,
    backgroundColor: "#1A73E8",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  consolidateButtonDisabled: { opacity: 0.6 },
  consolidateButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  list: { paddingHorizontal: 24, paddingBottom: 40 },
  skillCard: {
    backgroundColor: "#F8F9FA",
    borderRadius: 10,
    padding: 14,
    marginBottom: 10,
  },
  skillHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  skillName: { fontSize: 16, fontWeight: "600", color: "#1A1A1A", flex: 1 },
  badge: {
    backgroundColor: "#E8F0FE",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: { fontSize: 11, color: "#1A73E8", fontWeight: "500" },
  skillDesc: { fontSize: 13, color: "#5F6368", lineHeight: 18, marginBottom: 8 },
  skillMeta: { flexDirection: "row", justifyContent: "space-between" },
  metaText: { fontSize: 12, color: "#9AA0A6" },
  mergedText: { fontSize: 12, color: "#1A73E8" },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { fontSize: 15, color: "#5F6368", textAlign: "center", lineHeight: 22 },
});
