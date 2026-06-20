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
} from "react-native";
import { askAgent, type AgentResponse, type MatchedSkillGroup } from "../services/ragAgent";
import { getApiKey } from "../services/api";
import type { Skill } from "../types";
import { CATEGORY_LABELS } from "../services/skills";

interface Message {
  role: "user" | "agent";
  content: string;
  sources?: string[];
  grounded?: boolean;
  matchedSkillGroup?: MatchedSkillGroup;
}

export default function SearchScreen() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      content:
        "Ask me anything about your recorded meetings and classes. I'll search your knowledge base for answers.",
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const showSkillDetail = useCallback((skill: Skill) => {
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
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Search</Text>
        <Text style={styles.subtitle}>Ask anything from your knowledge base</Text>
      </View>

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.messages}
        onContentSizeChange={() => flatListRef.current?.scrollToEnd()}
        renderItem={({ item }) => (
          <View
            style={[
              styles.bubble,
              item.role === "user" ? styles.userBubble : styles.agentBubble,
            ]}
          >
            {item.matchedSkillGroup && (
              <View style={styles.skillsSection}>
                <Text style={styles.skillsTitle}>
                  📋 相关已总结 Skill
                </Text>
                <Text style={styles.skillsGroupLabel}>
                  {item.matchedSkillGroup.group.icon} {item.matchedSkillGroup.group.label}
                </Text>
                <View style={styles.skillsRow}>
                  {item.matchedSkillGroup.skills.map((s) => (
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
          placeholder="Ask a question..."
          placeholderTextColor="#9AA0A6"
          value={input}
          onChangeText={setInput}
          onSubmitEditing={handleSend}
          returnKeyType="send"
          editable={!loading}
        />
        <TouchableOpacity
          style={[styles.sendButton, !input.trim() && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!input.trim() || loading}
        >
          {loading ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  header: { padding: 24, paddingTop: 60, paddingBottom: 12 },
  title: { fontSize: 32, fontWeight: "700", color: "#1A1A1A" },
  subtitle: { fontSize: 14, color: "#5F6368", marginTop: 4 },
  messages: { paddingHorizontal: 16, paddingBottom: 12 },
  bubble: {
    maxWidth: "85%",
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#1A73E8",
  },
  agentBubble: {
    alignSelf: "flex-start",
    backgroundColor: "#F1F3F4",
  },
  bubbleText: { fontSize: 15, lineHeight: 22 },
  userText: { color: "#FFFFFF" },
  agentText: { color: "#1A1A1A" },
  sources: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(0,0,0,0.1)",
  },
  sourcesTitle: {
    fontSize: 12,
    fontWeight: "600",
    color: "rgba(0,0,0,0.5)",
    marginBottom: 6,
  },
  sourceItem: {
    fontSize: 11,
    color: "rgba(0,0,0,0.4)",
    marginBottom: 3,
    lineHeight: 15,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    paddingBottom: 32,
    borderTopWidth: 1,
    borderTopColor: "#E8EAED",
    gap: 10,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#DADCE0",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    backgroundColor: "#F8F9FA",
  },
  sendButton: {
    backgroundColor: "#1A73E8",
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  sendButtonDisabled: { backgroundColor: "#DADCE0" },
  sendButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  skillsSection: {
    marginBottom: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(0,0,0,0.08)",
  },
  skillsTitle: { fontSize: 12, fontWeight: "600", color: "rgba(0,0,0,0.55)", marginBottom: 4 },
  skillsGroupLabel: { fontSize: 13, fontWeight: "600", color: "#1A1A1A", marginBottom: 6 },
  skillsRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  skillBadge: {
    backgroundColor: "#E8F0FE",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  skillBadgeText: { fontSize: 12, color: "#1A73E8", fontWeight: "500" },
});
