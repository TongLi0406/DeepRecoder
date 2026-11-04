import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { Skill, ConsolidationResult } from "../types";
import {
  getAllSkills,
  findConsolidationCandidates,
  CATEGORY_LABELS,
} from "../services/skills";
import { quickConsolidation } from "../services/consolidation";
import { exportDocument, skillsToHtml, skillsToMarkdown } from "../services/export";
import { Download, FileText, Layers, Workflow } from "lucide-react-native";
import { colors, fonts, IconButton, PageEntrance } from "../ui";

export default function SkillsScreen() {
  const navigation = useNavigation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [candidateCount, setCandidateCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [consolidating, setConsolidating] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [feedback, setFeedback] = useState("");

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const all = await getAllSkills();
      setSkills(all);
      const candidates = await findConsolidationCandidates(all, 0.70);
      setCandidateCount(candidates.length);
    } catch { setFeedback("无法加载技能。"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void loadSkills();
    return navigation.addListener("focus", loadSkills);
  }, [navigation, loadSkills]);

  const handleExport = useCallback(async (format: "pdf" | "markdown") => {
    if (skills.length === 0) return;
    setExporting(true); setFeedback("");
    try {
      await exportDocument(format, "skills_summary", format === "pdf" ? skillsToHtml(skills) : skillsToMarkdown(skills));
      setExportOpen(false);
    } catch (error: any) { setFeedback(error.message ?? "导出失败。"); }
    finally { setExporting(false); }
  }, [skills]);

  const handleConsolidate = useCallback(async () => {
    setConsolidating(true);
    try {
      const result: ConsolidationResult = await quickConsolidation(0.70);
      const msg =
        result.merged.length > 0
          ? `已合并 ${result.merged.length} 组技能，跳过 ${result.skipped.length} 组。`
          : "暂无可合并的技能。多录制一些会话即可积累技能库。";
      setFeedback(msg);
      await loadSkills();
    } catch (e: any) {
      setFeedback(e.message ?? "技能合并失败");
    } finally {
      setConsolidating(false);
    }
  }, [loadSkills]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }

  return (
    <PageEntrance style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.subtitle}>{skills.length} 个技能</Text>
        {skills.length > 0 && (
          <IconButton icon={Download} label="导出技能" disabled={exporting} onPress={() => setExportOpen(value => !value)} />
        )}
      </View>
      {!!feedback && <Text accessibilityRole="alert" style={styles.feedback}>{feedback}</Text>}
      {exportOpen && <View style={styles.exportOptions}>
        {(["pdf", "markdown"] as const).map(format => <TouchableOpacity key={format} accessibilityRole="button" disabled={exporting}
          onPress={() => void handleExport(format)} style={styles.exportOption}>
          <FileText size={18} color={colors.accent} /><Text style={styles.subtitle}>{format === "pdf" ? "PDF" : "Markdown"}</Text>
        </TouchableOpacity>)}
      </View>}

      {candidateCount > 0 && (
        <TouchableOpacity
          style={[styles.consolidateButton, consolidating && styles.consolidateButtonDisabled]}
          onPress={handleConsolidate}
          disabled={consolidating}
          accessibilityRole="button"
        >
          <Workflow size={18} color={colors.surface} />
          {consolidating ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.consolidateButtonText}>
              合并（{candidateCount}）
            </Text>
          )}
        </TouchableOpacity>
      )}

      {skills.length === 0 ? (
        <View style={styles.empty}>
          <Layers size={32} color={colors.muted} strokeWidth={1.3} />
          <Text style={styles.emptyText}>
            暂无技能
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
                  已使用 {item.useCount} 次 · 关联 {item.sourceSessionIds.length} 个会话
                </Text>
                {item.mergedFrom.length > 0 && (
                  <Text style={styles.mergedText}>
                    由 {item.mergedFrom.length} 个技能合并
                  </Text>
                )}
              </View>
            </View>
          )}
        />
      )}
    </PageEntrance>
  );
}

const styles = StyleSheet.create({
  feedback: { fontSize: 13, fontFamily: fonts.body, color: colors.accent, marginHorizontal: 24, marginBottom: 16 },
  exportOptions: { flexDirection: "row", gap: 12, marginHorizontal: 24, marginBottom: 12 },
  exportOption: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  header: { paddingHorizontal: 24, paddingBottom: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontSize: 32, fontWeight: "700", color: "#1A1A1A" },
  subtitle: { fontSize: 13, fontFamily: fonts.body, color: colors.muted },
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
    backgroundColor: colors.accent,
    borderRadius: 8,
    flexDirection: "row", gap: 10, justifyContent: "center",
    paddingVertical: 14,
    alignItems: "center",
  },
  consolidateButtonDisabled: { opacity: 0.6 },
  consolidateButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  list: { paddingHorizontal: 24, paddingBottom: 40 },
  skillCard: {
    borderBottomWidth: 1, borderBottomColor: colors.line,
    paddingVertical: 20,
  },
  skillHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  skillName: { fontSize: 16, fontFamily: fonts.strong, color: colors.text, flex: 1 },
  badge: {
    backgroundColor: colors.soft, maxWidth: "45%",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  badgeText: { fontSize: 11, color: colors.accent, fontFamily: fonts.body },
  skillDesc: { fontSize: 14, fontFamily: fonts.body, color: colors.muted, lineHeight: 22, marginBottom: 12 },
  skillMeta: { flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "space-between" },
  metaText: { fontSize: 12, fontFamily: fonts.body, color: colors.muted },
  mergedText: { fontSize: 12, fontFamily: fonts.body, color: colors.accent },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { fontSize: 18, fontFamily: fonts.strong, color: colors.text, textAlign: "center", lineHeight: 26 },
});
