import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { Session } from "../types";
import { getAllSessions, getSessionById, deleteSession } from "../services/storage";
import { getCourseGroups, type CourseGroup } from "../services/courses";
import { ArrowUpRight, AudioLines, Trash2 } from "lucide-react-native";
import { colors, fonts, IconButton, PageEntrance, PHASE_LABELS } from "../ui";

type Nav = NativeStackNavigationProp<RootStackParamList, "Main">;

const MODE_LABELS: Record<string, string> = {
  "meeting-organizer": "会议 · 主持",
  "meeting-attendee": "会议 · 参会",
  "classroom-student": "课堂 · 学生",
  "classroom-teacher": "课堂 · 教师",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return "今天";
  if (diff < 172800000) return "昨天";
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export default function HistoryScreen() {
  const navigation = useNavigation<Nav>();
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const sessions = await getAllSessions();
      const courseGroups = await getCourseGroups(sessions);
      setGroups(courseGroups);
    } catch {
      setError("无法加载录音。");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void loadData();
    const unsubscribe = navigation.addListener("focus", loadData);
    return unsubscribe;
  }, [navigation, loadData]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" color={colors.accent} />
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View style={styles.empty}>
        <AudioLines size={32} strokeWidth={1.3} color={colors.muted} />
        <Text style={styles.emptyTitle}>{error ? "录音不可用" : "暂无录音"}</Text>
        {error ? <Text accessibilityRole="alert" style={styles.feedback}>{error}</Text>
          : <Text style={styles.emptySubtitle}>0 个会话</Text>}
      </View>
    );
  }

  return (
    <PageEntrance style={styles.container}>
      {!!error && <Text accessibilityRole="alert" style={styles.feedback}>{error}</Text>}
      <SectionList
        sections={groups.map((g) => ({
          title: g.courseName,
          data: g.sessions,
          count: g.sessionCount,
        }))}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>{section.title}</Text>
            <Text style={styles.sectionCount}>{section.count} 个会话</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const s = item as CourseGroup["sessions"][0];
          const handleDelete = async () => {
            if (Platform.OS === "web") {
              if (!window.confirm("确定永久删除这条录音及其数据？")) return;
              try { await deleteSession(s.id); await loadData(); }
              catch { setError("无法删除该录音。"); }
              return;
            }
            Alert.alert("删除会话", "将永久删除该会话及其数据。", [
              { text: "取消", style: "cancel" },
              {
                text: "删除",
                style: "destructive",
                onPress: async () => {
                  try { await deleteSession(s.id); await loadData(); }
                  catch { setError("无法删除该录音。"); }
                },
              },
            ]);
          };
          return (
            <View style={styles.item}>
            <TouchableOpacity
              style={styles.openButton}
              accessibilityRole="button"
              accessibilityLabel={`打开 ${s.topic || "未命名录音"}`}
              onPress={() => {
                getSessionById(s.id).then((full) => {
                  if (full) {
                    navigation.navigate("Summary", { session: full });
                  }
                }).catch(() => setError("无法打开该录音。"));
              }}
              onLongPress={handleDelete}
            >
              <View style={styles.itemLeft}>
                <Text style={styles.itemTopic} numberOfLines={1}>
                  {s.topic || "未命名录音"}
                </Text>
                <Text style={styles.itemDate}>
                  {formatDate(s.date)}
                  {s.phase === "failed" ? " · 失败" : s.phase && s.phase !== "done" ? ` · ${PHASE_LABELS[s.phase] ?? s.phase}` : ""}
                </Text>
              </View>
              <ArrowUpRight size={18} color={colors.muted} />
            </TouchableOpacity>
              <IconButton icon={Trash2} label={`删除 ${s.topic || "未命名录音"}`} onPress={handleDelete} />
            </View>
          );
        }}
        contentContainerStyle={styles.list}
      />
    </PageEntrance>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  feedback: { paddingHorizontal: 24, paddingVertical: 8, fontFamily: fonts.body, fontSize: 14, lineHeight: 22, color: colors.red },
  title: {
    fontSize: 32,
    fontWeight: "700",
    color: "#1A1A1A",
    padding: 24,
    paddingTop: 60,
    paddingBottom: 8,
  },
  list: { paddingHorizontal: 24, paddingBottom: 40 },
  center: { flex: 1, justifyContent: "center", alignItems: "center" },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 24,
    marginBottom: 8,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#E8EAED",
  },
  sectionTitle: { flex: 1, fontSize: 16, fontFamily: fonts.strong, color: colors.text },
  sectionCount: { fontSize: 12, fontFamily: fonts.body, color: colors.muted },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: colors.line,
    backgroundColor: colors.background,
  },
  openButton: { flex: 1, minWidth: 0, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 12 },
  itemLeft: { flex: 1, minWidth: 0 },
  itemTopic: { fontSize: 15, fontFamily: fonts.strong, color: colors.text },
  itemDate: { fontSize: 12, fontFamily: fonts.body, color: colors.muted, marginTop: 5 },
  itemArrow: { fontSize: 18, color: "#9AA0A6" },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 24, gap: 14 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontFamily: fonts.strong, color: colors.text },
  emptySubtitle: { fontSize: 13, fontFamily: fonts.body, color: colors.muted, textAlign: "center" },
});
