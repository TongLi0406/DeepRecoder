import { useState, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView, useWindowDimensions } from "react-native";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { Session, SessionMode } from "../types";
import { ArrowUpRight, AudioLines, GraduationCap, Mic, Users } from "lucide-react-native";
import { getAllSessions } from "../services/storage";
import { colors, fonts, PageEntrance, PHASE_LABELS, ScreenHeader, uiStyles } from "../ui";

type Nav = NativeStackNavigationProp<RootStackParamList, "Main">;

export default function HomeScreen() {
  const navigation = useNavigation<Nav>();
  const [selectedMode, setSelectedMode] = useState<SessionMode>("meeting-attendee");
  const [recent, setRecent] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const wide = useWindowDimensions().width >= 900;
  const classroom = selectedMode.startsWith("classroom");
  const roles: { label: string; mode: SessionMode }[] = classroom
    ? [{ label: "学生", mode: "classroom-student" }, { label: "教师", mode: "classroom-teacher" }]
    : [{ label: "参会者", mode: "meeting-attendee" }, { label: "主持人", mode: "meeting-organizer" }];
  useFocusEffect(useCallback(() => {
    let current = true;
    getAllSessions().then(sessions => { if (current) { setRecent(sessions.slice(0, 4)); setError(""); } })
      .catch(() => { if (current) setError("最近录音加载失败。"); });
    return () => { current = false; };
  }, []));

  return (
    <View style={uiStyles.page}>
      <ScreenHeader title="录音" caption={new Date().toLocaleDateString("zh-CN", { weekday: "long", month: "long", day: "numeric" })} />
      <ScrollView contentContainerStyle={styles.content}>
        <PageEntrance style={[styles.workspace, wide && { flexDirection: "row", gap: 48 }]}>
          <View style={{ flex: 1 }}>
            <Text style={uiStyles.label}>会话类型</Text>
            <View style={uiStyles.segmented}>
              {[{ label: "会议", icon: Users, mode: "meeting-attendee" }, { label: "课堂", icon: GraduationCap, mode: "classroom-student" }].map(item => {
                const selected = classroom === (item.label === "课堂");
                const Icon = item.icon;
                return <Pressable key={item.label} accessibilityRole="tab" accessibilityState={{ selected }}
                  onPress={() => setSelectedMode(item.mode as SessionMode)}
                  style={[uiStyles.segment, { flexDirection: "row", gap: 8 }, selected && uiStyles.segmentActive]}>
                  <Icon size={18} color={selected ? colors.accent : colors.muted} strokeWidth={1.7} />
                  <Text style={[uiStyles.segmentText, selected && { color: colors.accent }]}>{item.label}</Text>
                </Pressable>;
              })}
            </View>
            <View style={styles.roles}>
              <Text style={[uiStyles.label, { marginBottom: 0, marginRight: 8 }]}>我的角色</Text>
              {roles.map(item => <Pressable key={item.mode} accessibilityRole="radio" accessibilityState={{ checked: selectedMode === item.mode }}
                onPress={() => setSelectedMode(item.mode)} style={styles.role}>
                <View style={[styles.radio, selectedMode === item.mode && { borderColor: colors.accent }]}>
                  {selectedMode === item.mode && <View style={styles.radioDot} />}
                </View>
                <Text style={[uiStyles.segmentText, selectedMode === item.mode && { color: colors.text }]}>{item.label}</Text>
              </Pressable>)}
            </View>
            <View style={styles.captureArea}>
              <View style={styles.captureOutline}>
                <Pressable accessibilityRole="button" accessibilityLabel="开始录音"
                  onPress={() => navigation.navigate("Recording", { mode: selectedMode, autoStart: true })}
                  style={({ pressed }) => [styles.recordButton, pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] }]}>
                  <Mic size={38} color={colors.surface} strokeWidth={1.5} />
                </Pressable>
              </View>
              <Text style={styles.captureTitle}>开始录音</Text>
              <View style={styles.ready}><View style={styles.readyDot} /><Text style={styles.readyText}>就绪</Text></View>
            </View>
          </View>
          <View style={[styles.recent, wide && { width: "40%", borderTopWidth: 0, borderLeftWidth: 1, paddingLeft: 32, paddingTop: 0 }]}>
            <Text style={uiStyles.label}>最近录音</Text>
            {error ? <Text style={[uiStyles.body, { color: colors.red }]}>{error}</Text>
              : recent.length === 0 ? <View style={styles.empty}>
                <AudioLines size={26} color={colors.muted} strokeWidth={1.4} />
                <Text style={styles.emptyTitle}>暂无录音</Text>
                <Text style={styles.emptyCaption}>0 个会话</Text>
              </View> : recent.map(session => <Pressable key={session.id} accessibilityRole="button"
                accessibilityLabel={`打开 ${session.title || session.courseName || "录音"}`}
                onPress={() => navigation.navigate("Summary", { session })} style={styles.recentItem}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.recentTitle} numberOfLines={2}>{session.title || session.courseName || "未命名录音"}</Text>
                  <Text style={styles.emptyCaption}>{new Date(session.createdAt).toLocaleDateString("zh-CN")} · {Math.round(session.audioDuration / 60000)} 分钟 · {PHASE_LABELS[session.phase] ?? session.phase}</Text>
                </View>
                <ArrowUpRight size={18} color={colors.muted} />
              </Pressable>)}
          </View>
        </PageEntrance>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingBottom: 32 },
  workspace: { paddingTop: 12 },
  roles: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 12, marginTop: 14 },
  role: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  radioDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  captureArea: { alignItems: "center", paddingVertical: 34, gap: 12 },
  captureOutline: { width: 160, height: 160, borderRadius: 80, borderWidth: 1, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  recordButton: { width: 124, height: 124, borderRadius: 62, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  captureTitle: { fontFamily: fonts.strong, fontSize: 17, color: colors.text, marginTop: 8 },
  ready: { flexDirection: "row", gap: 6, alignItems: "center" },
  readyDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent },
  readyText: { fontFamily: fonts.body, fontSize: 12, color: colors.muted },
  recent: { borderTopWidth: 1, borderColor: colors.line, paddingTop: 24 },
  empty: { paddingVertical: 18, gap: 10 },
  emptyTitle: { fontFamily: fonts.strong, fontSize: 15, color: colors.text },
  emptyCaption: { fontFamily: fonts.body, fontSize: 12, color: colors.muted, marginTop: 4 },
  recentItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: colors.line },
  recentTitle: { fontFamily: fonts.strong, fontSize: 15, color: colors.text },
});
