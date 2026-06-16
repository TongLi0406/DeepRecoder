import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
} from "react-native";
import { getApiKey, saveApiKey, deleteApiKey, testConnection } from "../services/api";

export default function SettingsScreen() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<"unknown" | "valid" | "invalid">("unknown");

  useEffect(() => {
    getApiKey().then((key) => {
      if (key) {
        setApiKey(key);
        setHasKey(true);
      }
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) {
      Alert.alert("Error", "Please enter an API key");
      return;
    }
    await saveApiKey(apiKey.trim());
    setHasKey(true);
    setStatus("unknown");
    Alert.alert("Saved", "API key saved securely on-device");
  }, [apiKey]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setStatus("unknown");
    try {
      const ok = await testConnection(apiKey.trim());
      setStatus(ok ? "valid" : "invalid");
      Alert.alert(
        ok ? "Connected" : "Failed",
        ok ? "API connection successful" : "Could not connect. Check your key and network.",
      );
    } catch {
      setStatus("invalid");
      Alert.alert("Error", "Connection test failed");
    } finally {
      setTesting(false);
    }
  }, [apiKey]);

  const handleDelete = useCallback(async () => {
    await deleteApiKey();
    setApiKey("");
    setHasKey(false);
    setStatus("unknown");
    Alert.alert("Removed", "API key removed from device");
  }, []);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>

      <Text style={styles.sectionTitle}>API Key</Text>
      <Text style={styles.sectionDesc}>
        Connect your DeepSeek or Qwen API key. Your key stays on-device and is
        never sent anywhere except to the API provider directly.
      </Text>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="sk-..."
          placeholderTextColor="#9AA0A6"
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry={!showKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity
          style={styles.showButton}
          onPress={() => setShowKey((v) => !v)}
        >
          <Text style={styles.showButtonText}>{showKey ? "Hide" : "Show"}</Text>
        </TouchableOpacity>
      </View>

      {status !== "unknown" && (
        <View
          style={[
            styles.statusBadge,
            status === "valid" ? styles.statusValid : styles.statusInvalid,
          ]}
        >
          <Text
            style={[
              styles.statusText,
              status === "valid" ? styles.statusTextValid : styles.statusTextInvalid,
            ]}
          >
            {status === "valid" ? "Connection OK" : "Connection Failed"}
          </Text>
        </View>
      )}

      <View style={styles.buttonRow}>
        <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
          <Text style={styles.saveButtonText}>Save</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.testButton, testing && styles.testButtonDisabled]}
          onPress={handleTest}
          disabled={testing}
        >
          {testing ? (
            <ActivityIndicator size="small" color="#1A73E8" />
          ) : (
            <Text style={styles.testButtonText}>Test Connection</Text>
          )}
        </TouchableOpacity>
      </View>

      {hasKey && (
        <TouchableOpacity style={styles.deleteButton} onPress={handleDelete}>
          <Text style={styles.deleteButtonText}>Remove Key</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.sectionTitle}>Data</Text>
      <Text style={styles.aboutText}>
        Audio recordings are stored locally and should be deleted periodically.
        {"\n"}
        Structured summaries and knowledge base are kept permanently.
      </Text>

      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>About</Text>
      <Text style={styles.aboutText}>
        Recorder v1.0.0{"\n"}
        Local-first meeting & classroom intelligence{"\n"}
        Your data never leaves your device without your API key
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { padding: 24, paddingTop: 60 },
  title: { fontSize: 32, fontWeight: "700", color: "#1A1A1A", marginBottom: 24 },
  sectionTitle: { fontSize: 18, fontWeight: "600", color: "#1A1A1A", marginBottom: 8 },
  sectionDesc: { fontSize: 13, color: "#5F6368", marginBottom: 16, lineHeight: 18 },
  inputRow: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#DADCE0",
    borderRadius: 10,
    padding: 12,
    fontSize: 15,
    color: "#1A1A1A",
    backgroundColor: "#F8F9FA",
  },
  showButton: { marginLeft: 12 },
  showButtonText: { color: "#1A73E8", fontSize: 14, fontWeight: "500" },
  statusBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 12,
  },
  statusValid: { backgroundColor: "#E6F4EA" },
  statusInvalid: { backgroundColor: "#FCE8E6" },
  statusText: { fontSize: 12, fontWeight: "500" },
  statusTextValid: { color: "#137333" },
  statusTextInvalid: { color: "#C5221F" },
  buttonRow: { flexDirection: "row", gap: 12, marginBottom: 12 },
  saveButton: {
    backgroundColor: "#1A73E8",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  saveButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  testButton: {
    borderWidth: 1,
    borderColor: "#1A73E8",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  testButtonDisabled: { opacity: 0.5 },
  testButtonText: { color: "#1A73E8", fontSize: 15, fontWeight: "500" },
  deleteButton: { alignItems: "center", paddingVertical: 8, marginBottom: 24 },
  deleteButtonText: { color: "#C5221F", fontSize: 14 },
  aboutText: { fontSize: 13, color: "#5F6368", lineHeight: 20 },
});
