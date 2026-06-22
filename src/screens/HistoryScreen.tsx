import { useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
} from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { Session } from "../types";
import { getAllSessions, getSessionById, deleteSession } from "../services/storage";
import { getCourseGroups, type CourseGroup } from "../services/courses";

type Nav = NativeStackNavigationProp<RootStackParamList, "Main">;

const MODE_LABELS: Record<string, string> = {
  "meeting-organizer": "Meeting · Org",
  "meeting-attendee": "Meeting · Me",
  "classroom-student": "Class · Student",
  "classroom-teacher": "Class · Teacher",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 86400000) return "Today";
  if (diff < 172800000) return "Yesterday";
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

export default function HistoryScreen() {
  const navigation = useNavigation<Nav>();
  const [groups, setGroups] = useState<CourseGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    const sessions = await getAllSessions();
    const courseGroups = await getCourseGroups(sessions);
    setGroups(courseGroups);
    setLoading(false);
  }, []);

  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", loadData);
    return unsubscribe;
  }, [navigation, loadData]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1A73E8" />
      </View>
    );
  }

  if (groups.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyIcon}>📋</Text>
        <Text style={styles.emptyTitle}>No recordings yet</Text>
        <Text style={styles.emptySubtitle}>
          Your recorded sessions will appear here, grouped by course
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>History</Text>
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
            <Text style={styles.sectionCount}>{section.count} sessions</Text>
          </View>
        )}
        renderItem={({ item }) => {
          const s = item as CourseGroup["sessions"][0];
          const handleDelete = () => {
            Alert.alert("Delete Session", "This will permanently remove the session and its data.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                  await deleteSession(s.id);
                  loadData();
                },
              },
            ]);
          };
          return (
            <TouchableOpacity
              style={styles.item}
              onPress={() => {
                getSessionById(s.id).then((full) => {
                  if (full) {
                    navigation.navigate("Summary", { session: full });
                  }
                });
              }}
              onLongPress={handleDelete}
            >
              <View style={styles.itemLeft}>
                <Text style={styles.itemTopic} numberOfLines={1}>
                  {s.topic || "Untitled"}
                </Text>
                <Text style={styles.itemDate}>
                  {formatDate(s.date)}
                  {s.phase === "failed" ? " · Failed" : s.phase !== "done" ? ` · ${s.phase}` : ""}
                </Text>
              </View>
              <Text style={styles.itemArrow}>→</Text>
            </TouchableOpacity>
          );
        }}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
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
  sectionTitle: { fontSize: 18, fontWeight: "600", color: "#1A1A1A" },
  sectionCount: { fontSize: 13, color: "#5F6368" },
  item: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    paddingHorizontal: 12,
    backgroundColor: "#F8F9FA",
    borderRadius: 10,
    marginBottom: 6,
  },
  itemLeft: { flex: 1 },
  itemTopic: { fontSize: 15, fontWeight: "500", color: "#1A1A1A" },
  itemDate: { fontSize: 12, color: "#9AA0A6", marginTop: 2 },
  itemArrow: { fontSize: 18, color: "#9AA0A6" },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", padding: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 20, fontWeight: "600", color: "#1A1A1A" },
  emptySubtitle: { fontSize: 14, color: "#5F6368", marginTop: 8, textAlign: "center" },
});
