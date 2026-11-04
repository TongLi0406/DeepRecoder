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
      .catch(() => setFeedback("无法加载模型配置。"));
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
      setFeedback("请输入 API 密钥。");
      return;
    }
    try {
      await saveApiKey(apiKey.trim());
      setHasKey(true);
      setStatus("unknown");
      setFeedback("模型 API 密钥已保存在本机。");
    } catch { setFeedback("无法保存模型 API 密钥。"); }
  }, [apiKey]);

  const handleTest = useCallback(async () => {
    if (modelDirty) return;
    setTesting(true);
    setStatus("unknown");
    try {
      const result = await testConnection(apiKey.trim());
      setStatus(result.ok ? "valid" : "invalid");
      setFeedback(result.ok ? "模型连接成功。" : `连接失败：${result.detail ?? "未知原因"}`);
    } catch (error: any) {
      setStatus("invalid");
      setFeedback(`模型连接测试失败：${error?.message ?? "未知原因"}`);
    } finally {
      setTesting(false);
    }
  }, [apiKey, modelDirty]);

  const handleDelete = useCallback(async () => {
    try {
      await deleteApiKey();
      setApiKey(""); setHasKey(false); setStatus("unknown");
      setFeedback("模型 API 密钥已从本机移除。");
    } catch { setFeedback("无法移除模型 API 密钥。"); }
  }, []);

  const handleSfSave = useCallback(async () => {
    if (!sfKey.trim()) {
      setFeedback("请输入 SiliconFlow API 密钥。");
      return;
    }
    try {
      await saveSiliconFlowKey(sfKey.trim());
      setSfHasKey(true); setSfStatus("unknown");
      setFeedback("SiliconFlow API 密钥已保存在本机。");
    } catch { setFeedback("无法保存 SiliconFlow API 密钥。"); }
  }, [sfKey]);

  const handleSfTest = useCallback(async () => {
    setSfTesting(true);
    setSfStatus("unknown");
    try {
      const result = await testSiliconFlowConnection(sfKey.trim());
      setSfStatus(result.ok ? "valid" : "invalid");
      setFeedback(result.ok ? "SiliconFlow 连接成功。" : `SiliconFlow 连接失败：${result.detail ?? "未知原因"}`);
    } catch (error: any) {
      setSfStatus("invalid");
      setFeedback(`SiliconFlow 连接测试失败：${error?.message ?? "未知原因"}`);
    } finally {
      setSfTesting(false);
    }
  }, [sfKey]);

  const handleSfDelete = useCallback(async () => {
    try {
      await deleteSiliconFlowKey();
      setSfKey(""); setSfHasKey(false); setSfStatus("unknown");
      setFeedback("SiliconFlow API 密钥已从本机移除。");
    } catch { setFeedback("无法移除 SiliconFlow API 密钥。"); }
  }, []);

  return (
    <PageEntrance style={uiStyles.page}>
      <ScreenHeader title="设置" back />
      {!!feedback && <Text accessibilityRole="alert" style={styles.feedback}>{feedback}</Text>}
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>模型</Text>
      {model && <>
        <Text style={styles.aboutText}>HTTPS 接口地址</Text>
        <TextInput accessibilityLabel="HTTPS 接口地址" style={styles.input} value={model.endpoint} autoCapitalize="none" autoCorrect={false} keyboardType="url"
          onChangeText={endpoint => { setModel({ ...model, endpoint }); setModelDirty(true); }} />
        <Text style={styles.aboutText}>模型名称</Text>
        <TextInput accessibilityLabel="模型名称" style={styles.input} value={model.model} autoCapitalize="none" autoCorrect={false}
          onChangeText={name => { setModel({ ...model, model: name }); setModelDirty(true); }} />
        <Text style={styles.aboutText}>上下文长度（tokens）</Text>
        <TextInput accessibilityLabel="上下文长度（tokens）" style={styles.input} value={contextLimit} keyboardType="number-pad"
          onChangeText={value => { setContextLimit(value); setModelDirty(true); }} />
        <View style={[uiStyles.segmented, { marginTop: 12, marginBottom: 12 }]}>
          {(["anthropic", "openai"] as const).map(format => <TouchableOpacity key={format}
            accessibilityRole="radio" accessibilityState={{ checked: model.format === format }}
            style={[uiStyles.segment, model.format === format && uiStyles.segmentActive]}
            onPress={() => { setModel({ ...model, format }); setModelDirty(true); }}>
            <Text style={[uiStyles.segmentText, model.format === format && { color: colors.accent }]}>{format === "openai" ? "OpenAI" : "Anthropic"}</Text>
          </TouchableOpacity>)}
        </View>
        {modelDirty && <Text style={styles.aboutText}>模型配置尚未保存</Text>}
        <View style={styles.buttonRow}><IconButton icon={Save} label="保存模型配置" onPress={async () => {
          try {
            if (!/^\d+$/.test(contextLimit)) throw new Error("上下文长度必须是整数");
            const config = { ...model, contextLimit: Number(contextLimit) };
            await saveModelConfig(config);
            setModel(config); setModelDirty(false); setStatus("unknown");
            setFeedback("模型配置已保存。");
          } catch (error: any) { setFeedback(`模型配置无效：${error.message}`); }
        }} /></View>
      </>}

      <Text style={styles.sectionTitle}>API 密钥</Text>
      <Text style={styles.sectionDesc}>
        填入你的 DeepSeek 或 Qwen API 密钥。密钥只保存在本机，
        仅在请求时发送到你配置的模型接口。
      </Text>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          accessibilityLabel="模型 API 密钥"
          placeholder="sk-..."
          placeholderTextColor={colors.muted}
          value={apiKey}
          onChangeText={setApiKey}
          secureTextEntry={!showKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <IconButton icon={showKey ? EyeOff : Eye} label={showKey ? "隐藏模型 API 密钥" : "显示模型 API 密钥"} onPress={() => setShowKey(value => !value)} />
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
            {status === "valid" ? "连接正常" : "连接失败"}
          </Text>
        </View>
      )}

      <View style={styles.buttonRow}>
        <IconButton icon={Save} label="保存模型 API 密钥" onPress={handleSave} />

        <TouchableOpacity
          style={[styles.testButton, testing && styles.testButtonDisabled]}
          accessibilityRole="button"
          onPress={handleTest}
          disabled={testing || modelDirty}
        >
          {testing ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <><PlugZap size={18} color={colors.accent} /><Text style={styles.testButtonText}>测试连接</Text></>
          )}
        </TouchableOpacity>
        {hasKey && <IconButton icon={Trash2} label="移除模型 API 密钥" onPress={handleDelete} />}
      </View>

      <Text style={[styles.sectionTitle, { marginTop: 16 }]}>SiliconFlow API 密钥</Text>
      <Text style={styles.sectionDesc}>
        音频转写会将录音上传到 SiliconFlow，知识库向量化也会把文本发送给
        SiliconFlow。日记上传需要单独授权。
      </Text>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          accessibilityLabel="SiliconFlow API 密钥"
          placeholder="sk-..."
          placeholderTextColor={colors.muted}
          value={sfKey}
          onChangeText={setSfKey}
          secureTextEntry={!sfShowKey}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <IconButton icon={sfShowKey ? EyeOff : Eye} label={sfShowKey ? "隐藏 SiliconFlow API 密钥" : "显示 SiliconFlow API 密钥"} onPress={() => setSfShowKey(value => !value)} />
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
            {sfStatus === "valid" ? "连接正常" : "连接失败"}
          </Text>
        </View>
      )}

      <View style={styles.buttonRow}>
        <IconButton icon={Save} label="保存 SiliconFlow API 密钥" onPress={handleSfSave} />

        <TouchableOpacity
          style={[styles.testButton, sfTesting && styles.testButtonDisabled]}
          accessibilityRole="button"
          onPress={handleSfTest}
          disabled={sfTesting}
        >
          {sfTesting ? (
            <ActivityIndicator size="small" color={colors.accent} />
          ) : (
            <><PlugZap size={18} color={colors.accent} /><Text style={styles.testButtonText}>测试连接</Text></>
          )}
        </TouchableOpacity>
        {sfHasKey && <IconButton icon={Trash2} label="移除 SiliconFlow API 密钥" onPress={handleSfDelete} />}
      </View>

      <Text style={styles.sectionTitle}>数据</Text>
      <Text style={styles.aboutText}>
        录音文件保存在本机，建议定期清理。
        {"\n"}
        结构化总结和知识库会长期保留。
      </Text>

      <Text style={[styles.sectionTitle, { marginTop: 24 }]}>关于</Text>
      <Text style={styles.aboutText}>
        Recorder v1.0.0{"\n"}
        本地优先的会议与课堂智能助手
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
