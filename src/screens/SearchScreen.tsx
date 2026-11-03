import { useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
} from "react-native";
import { askAgent, type AgentResponse, type MatchedSkillGroup } from "../services/ragAgent";
import { getApiKey } from "../services/api";
import type { Skill } from "../types";
import { CATEGORY_LABELS } from "../services/skills";
import { MessagesSquare, Send } from "lucide-react-native";
import { colors, fonts, IconButton, PageEntrance, ScreenHeader, uiStyles } from "../ui";

interface Message {
  role: "user" | "agent";
  content: string;
  sources?: string[];
  grounded?: boolean;
  matchedSkillGroup?: MatchedSkillGroup;
}

export default function SearchScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const showSkillDetail = useCallback((skill: Skill) => {
    if (Platform.OS === "web") {
      window.alert(`${skill.name}\n\n${skill.description}\n\n${CATEGORY_LABELS[skill.category] ?? skill.category} · ${skill.sourceSessionIds.length} sessions`);
      return;
    }
    Alert.alert(
      skill.name,
      `${skill.description}\n\n分类：${CATEGORY_LABELS[skill.category] ?? skill.category}\n来源会话：${skill.sourceSessionIds.length} 个`,
    );
  }, []);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const apiKey = (await getApiKey()) ?? undefined;
      const response: AgentResponse = await askAgent(question, undefined, apiKey);

      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: response.answer,
          sources: response.sources,
          grounded: response.grounded,
          matchedSkillGroup: response.matchedSkillGroup,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "agent",
          content: e.message ?? "Search failed. Check your API key and network.",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading]);

  return (
    <PageEntrance style={uiStyles.page}>
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ScreenHeader title="Ask" />

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.messages}
        ListEmptyComponent={<View style={styles.empty}><MessagesSquare size={36} strokeWidth={1.3} color={colors.muted} /><Text style={styles.emptyText}>No conversation yet</Text></View>}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
        renderItem={({ item }) => (
          <View
            style={[
              styles.bubble,
              item.role === "user" ? styles.userBubble : styles.agentBubble,
            ]}
          >
            <Text style={styles.speakerLabel}>{item.role === "user" ? "You" : "Answer"}</Text>
            {item.matchedSkillGroup && (
              <View style={styles.skillsSection}>
                <Text style={styles.skillsTitle}>
                  Related skills
                </Text>
                <Text style={styles.skillsGroupLabel}>
                  {item.matchedSkillGroup.group.label}
                </Text>
                <View style={styles.skillsRow}>
                  {item.matchedSkillGroup.skills.map((s: { skill: import("../types").Skill }) => (
                    <TouchableOpacity
                      key={s.skill.id}
                      style={styles.skillBadge}
                      onPress={() => showSkillDetail(s.skill)}
                    >
                      <Text style={styles.skillBadgeText}>{s.skill.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            <Text
              style={[
                styles.bubbleText,
                item.role === "user" ? styles.userText : styles.agentText,
              ]}
            >
              {item.content}
            </Text>

            {item.sources && item.sources.length > 0 && (
              <View style={styles.sources}>
                <Text style={styles.sourcesTitle}>
                  Sources ({item.sources.length}){item.grounded === false ? " — may contain unverified info" : ""}
                </Text>
                {item.sources.slice(0, 3).map((s: string, i: number) => (
                  <Text key={i} style={styles.sourceItem} numberOfLines={2}>
                    {s}
                  </Text>
                ))}
              </View>
            )}
          </View>
        )}
      />

      <View style={styles.inputBar}>
        <TextInput
          style={styles.input}
          placeholder="Your question"
          accessibilityLabel="Question"
          placeholderTextColor={colors.muted}
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!loading}
        />
        <View style={styles.sendControl}>
          {loading ? (
            <ActivityIndicator accessibilityLabel="Generating answer" size="small" color={colors.accent} />
          ) : (
            <IconButton icon={Send} label="Send question" onPress={handleSend} disabled={!input.trim()} />
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
    </PageEntrance>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  messages: { paddingHorizontal: 24, paddingBottom: 12, flexGrow: 1 },
  empty: { flex: 1, justifyContent: "center", alignItems: "center", gap: 16 },
  emptyText: { fontSize: 16, fontFamily: fonts.body, color: colors.muted },
  speakerLabel: { fontSize: 11, fontFamily: fonts.strong, color: colors.muted, marginBottom: 8 },
  bubble: {
    maxWidth: "100%",
    borderRadius: 8,
    padding: 14,
    marginBottom: 16,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: colors.soft,
  },
  agentBubble: {
    alignSelf: "stretch",
    paddingHorizontal: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  bubbleText: { fontSize: 15, fontFamily: fonts.body, lineHeight: 25 },
  userText: { color: colors.text },
  agentText: { color: colors.text },
  sources: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  sourcesTitle: {
    fontSize: 12,
    fontFamily: fonts.strong,
    color: colors.muted,
    marginBottom: 6,
  },
  sourceItem: {
    fontSize: 11,
    fontFamily: fonts.body,
    color: colors.muted,
    marginBottom: 3,
    lineHeight: 15,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    gap: 10,
  },
  input: {
    flex: 1, minWidth: 0,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15, fontFamily: fonts.body, color: colors.text,
    backgroundColor: colors.surface,
  },
  sendControl: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  skillsSection: {
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  skillsTitle: { fontSize: 12, fontFamily: fonts.strong, color: colors.muted, marginBottom: 4 },
  skillsGroupLabel: { fontSize: 13, fontFamily: fonts.strong, color: colors.text, marginBottom: 6 },
  skillsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  skillBadge: {
    backgroundColor: colors.soft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
  },
  skillBadgeText: { fontSize: 12, color: colors.accent, fontFamily: fonts.strong },
});
