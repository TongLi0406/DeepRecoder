import { useState, useCallback, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { getApiKey, saveApiKey, deleteApiKey, testConnection, getModelConfig, saveModelConfig, type ModelConfig } from "../services/api";
import {
  getSiliconFlowKey,
  saveSiliconFlowKey,
  deleteSiliconFlowKey,
  testSiliconFlowConnection,
} from "../services/embedding";
import { Eye, EyeOff, PlugZap, Save, Trash2 } from "lucide-react-native";
import { colors, fonts, IconButton, PageEntrance, ScreenHeader, uiStyles } from "../ui";

export default function SettingsScreen() {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<"unknown" | "valid" | "invalid">("unknown");
  const [model, setModel] = useState<ModelConfig | null>(null);
  const [contextLimit, setContextLimit] = useState("");
  const [modelDirty, setModelDirty] = useState(false);
  const [feedback, setFeedback] = useState("");

  const [sfKey, setSfKey] = useState("");
  const [sfShowKey, setSfShowKey] = useState(false);
  const [sfHasKey, setSfHasKey] = useState(false);
  const [sfTesting, setSfTesting] = useState(false);
  const [sfStatus, setSfStatus] = useState<"unknown" | "valid" | "invalid">("unknown");

  useEffect(() => {
    getModelConfig().then(config => { setModel(config); setContextLimit(String(config.contextLimit)); })
      .catch(() => setFeedback("Could not load model configuration."));
    getApiKey().then((key) => {
      if (key) {
        setApiKey(key);
        setHasKey(true);
      }
    });
    getSiliconFlowKey().then((key) => {
      if (key) {
        setSfKey(key);
        setSfHasKey(true);
      }
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) {
      setFeedback("Please enter an API key.");
      return;
    }
    try {
      await saveApiKey(apiKey.trim());
      setHasKey(true);
      setStatus("unknown");
      setFeedback("Model API key saved on-device.");
    } catch { setFeedback("Could not save the model API key."); }
  }, [apiKey]);

  const handleTest = useCallback(async () => {
    if (modelDirty) return;
    setTesting(true);
    setStatus("unknown");
    try {
      const ok = await testConnection(apiKey.trim());
      setStatus(ok ? "valid" : "invalid");
      setFeedback(ok ? "Model connection successful." : "Could not connect. Check your key and network.");
    } catch {
      setStatus("invalid");
      setFeedback("Model connection test failed.");
    } finally {
      setTesting(false);
    }
  }, [apiKey, modelDirty]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteApiKey();
      setApiKey(""); setHasKey(false); setStatus("unknown");
      setFeedback("Model API key removed from device.");
    } catch { setFeedback("Could not remove the model API key."); }
  }, []);

  const handleSfSave = useCallback(async () => {
    if (!sfKey.trim()) {
      setFeedback("Please enter a SiliconFlow API key.");
      return;
    }
    try {
      await saveSiliconFlowKey(sfKey.trim());
      setSfHasKey(true); setSfStatus("unknown");
      setFeedback("SiliconFlow API key saved on-device.");
    } catch { setFeedback("Could not save the SiliconFlow API key."); }
  }, [sfKey]);

  const handleSfTest = useCallback(async () => {
    setSfTesting(true);
    setSfStatus("unknown");
    try {
      const ok = await testSiliconFlowConnection(sfKey.trim());
      setSfStatus(ok ? "valid" : "invalid");
      setFeedback(ok ? "SiliconFlow connection successful." : "Could not connect. Check your key and network.");
    } catch {
      setSfStatus("invalid");
      setFeedback("SiliconFlow connection test failed.");
    } finally {
      setSfTesting(false);
    }
  }, [sfKey]);

  const handleSfDelete = useCallback(async () => {
    try {
      await deleteSiliconFlowKey();
      setSfKey(""); setSfHasKey(false); setSfStatus("unknown");
      setFeedback("SiliconFlow API key removed from device.");
    } catch { setFeedback("Could not remove the SiliconFlow API key."); }
  }, []);

  return (
    <PageEntrance style={uiStyles.page}>
      <ScreenHeader title="Settings" back />
      {!!feedback && <Text accessibilityRole="alert" style={styles.feedback}>{feedback}</Text>}
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Model</Text>
      {model && <>
        <Text style={styles.aboutText}>HTTPS endpoint</Text>
        <TextInput accessibilityLabel="HTTPS endpoint" style={styles.input} value={model.endpoint} autoCapitalize="none" autoCorrect={false} keyboardType="url"
          onChangeText={endpoint => { setModel({ ...model, endpoint }); setModelDirty(true); }} />
        <Text style={styles.aboutText}>Model name</Text>
        <TextInput accessibilityLabel="Model name" style={styles.input} value={model.model} autoCapitalize="none" autoCorrect={false}
          onChangeText={name => { setModel({ ...model, model: name }); setModelDirty(true); }} />
        <Text style={styles.aboutText}>Context limit (tokens)</Text>
        <TextInput accessibilityLabel="Context limit in tokens" style={styles.input} value={contextLimit} keyboardType="number-pad"
          onChangeText={value => { setContextLimit(value); setModelDirty(true); }} />
        <View style={[uiStyles.segmented, { marginTop: 12, marginBottom: 12 }]}>
          {(["anthropic", "openai"] as const).map(format => <TouchableOpacity key={format}
            accessibilityRole="radio" accessibilityState={{ checked: model.format === format }}
            style={[uiStyles.segment, model.format === format && uiStyles.segmentActive]}
            onPress={() => { setModel({ ...model, format }); setModelDirty(true); }}>
            <Text style={[uiStyles.segmentText, model.format === format && { color: colors.accent }]}>{format === "openai" ? "OpenAI" : "Anthropic"}</Text>
          </TouchableOpacity>)}
        </View>
        {modelDirty && <Text style={styles.aboutText}>Unsaved model configuration</Text>}
        <View style={styles.buttonRow}><IconButton icon={Save} label="Save model configuration" onPress={async () => {
          try {
            if (!/^\d+$/.test(contextLimit)) throw new Error("Context limit must be an integer");
            const config = { ...model, contextLimit: Number(contextLimit) };
            await saveModelConfig(config);
            setModel(config); setModelDirty(false); setStatus("unknown");
            setFeedback("Model configuration saved.");
          } catch (error: any) { setFeedback(`Invalid model: ${error.message}`); }
        }} /></View>
      </>}

      <Text style={styles.sectionTitle}>API Key</Text>
      <Text style={styles.sectionDesc}>
        Connect your DeepSeek or Qwen API key. Your key stays on-device and is
        sent with requests only to the configured model endpoint.
      </Text>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          accessibilityLabel="Model API key"
          placeholder="sk-..."
          placeholderTextColor={colors.muted}
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry={!showKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <IconButton icon={showKey ? EyeOff : Eye} label={showKey ? "Hide model API key" : "Show model API key"} onPress={() => setShowKey(value => !value)} />
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
        <IconButton icon={Save} label="Save model API key" onPress={handleSave} />

        <TouchableOpacity
          style={[styles.testButton, testing && styles.testButtonDisabled]}
          accessibilityRole="button"
          onPress={handleTest}
          disabled={testing || modelDirty}
        >
          {testing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <><PlugZap size={18} color={colors.accent} /><Text style={styles.testButtonText}>Test Connection</Text></>
          )}
        </TouchableOpacity>
        {hasKey && <IconButton icon={Trash2} label="Remove model API key" onPress={handleDelete} />}
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 16 }]}>SiliconFlow API Key</Text>
      <Text style={styles.sectionDesc}>
        Audio transcription uploads recordings to SiliconFlow. Knowledge-base
        embeddings also send text to SiliconFlow. Diary uploads require separate consent.
      </Text>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          accessibilityLabel="SiliconFlow API key"
          placeholder="sk-..."
          placeholderTextColor={colors.muted}
          value={sfKey}
          onChangeText={setSfKey}
          secureTextEntry={!sfShowKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <IconButton icon={sfShowKey ? EyeOff : Eye} label={sfShowKey ? "Hide SiliconFlow API key" : "Show SiliconFlow API key"} onPress={() => setSfShowKey(value => !value)} />
      </View>

      {sfStatus !== "unknown" && (
        <View
          style={[
            styles.statusBadge,
            sfStatus === "valid" ? styles.statusValid : styles.statusInvalid,
          ]}
        >
          <Text
            style={[
              styles.statusText,
              sfStatus === "valid" ? styles.statusTextValid : styles.statusTextInvalid,
            ]}
          >
            {sfStatus === "valid" ? "Connection OK" : "Connection Failed"}
          </Text>
        </View>
      )}

      <View style={styles.buttonRow}>
        <IconButton icon={Save} label="Save SiliconFlow API key" onPress={handleSfSave} />

        <TouchableOpacity
          style={[styles.testButton, sfTesting && styles.testButtonDisabled]}
          accessibilityRole="button"
          onPress={handleSfTest}
          disabled={sfTesting}
        >
          {sfTesting ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <><PlugZap size={18} color={colors.accent} /><Text style={styles.testButtonText}>Test Connection</Text></>
          )}
        </TouchableOpacity>
        {sfHasKey && <IconButton icon={Trash2} label="Remove SiliconFlow API key" onPress={handleSfDelete} />}
      </View>

      <Text style={styles.sectionTitle}>Data</Text>
      <Text style={styles.aboutText}>
        Audio recordings are stored locally and should be deleted periodically.
        {"\n"}
        Structured summaries and knowledge base are kept permanently.
      </Text>

      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>About</Text>
      <Text style={styles.aboutText}>
        Recorder v1.0.0{"\n"}
        Local-first meeting & classroom intelligence
      </Text>
    </ScrollView>
    </PageEntrance>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 24, paddingTop: 4, paddingBottom: 32 },
  feedback: { fontSize: 13, fontFamily: fonts.body, color: colors.accent, paddingHorizontal: 24, paddingBottom: 16 },
  sectionTitle: { fontSize: 18, fontFamily: fonts.strong, color: colors.text, marginBottom: 12 },
  sectionDesc: { fontSize: 13, fontFamily: fonts.body, color: colors.muted, marginBottom: 16, lineHeight: 21 },
  inputRow: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
  input: {
    flex: 1, minWidth: 0, minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    padding: 12,
    fontSize: 14, fontFamily: fonts.body,
    color: colors.text,
    backgroundColor: colors.surface,
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
  statusValid: { backgroundColor: colors.soft },
  statusInvalid: { backgroundColor: "#FCE8E6" },
  statusText: { fontSize: 12, fontFamily: fonts.strong },
  statusTextValid: { color: colors.accent },
  statusTextInvalid: { color: colors.red },
  buttonRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 24 },
  saveButton: {
    backgroundColor: "#1A73E8",
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  saveButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  testButton: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
    minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
  },
  testButtonDisabled: { opacity: 0.5 },
  testButtonText: { color: colors.accent, fontSize: 13, fontFamily: fonts.strong },
  deleteButton: { alignItems: "center", paddingVertical: 8, marginBottom: 24 },
  deleteButtonText: { color: "#C5221F", fontSize: 14 },
  aboutText: { fontSize: 12, fontFamily: fonts.body, color: colors.muted, lineHeight: 21 },
});
