import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  applyRetentionPlan,
  cancelVoiceEnrollmentCapture,
  confirmSegmentIdentity,
  deleteFailedSegments,
  deleteSingleSegment,
  deleteVoiceProfile,
  finishVoiceEnrollmentCapture,
  generateDailyDiary,
  getDiaryQueueStats,
  getDiaryRuntimeStatus,
  getRetentionPlan,
  handleDiaryForeground,
  listDiaryDays,
  listSegmentsForDate,
  pauseDiaryCapture,
  prepareDiaryModels,
  processAllDiarySegments,
  processDiaryQueue,
  purgeDiaryData,
  resumeDiaryCapture,
  retrySegment,
  setDiaryConsentGranted,
  setDiaryRetentionPolicy,
  startDiaryCapture,
  startVoiceEnrollmentCapture,
  stopDiaryCapture,
} from "../services/diary";
import type { DailyDiary, DiaryRetentionDays, DiaryRuntimeStatus, DiarySegment } from "../types/diary";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import { ArrowUpRight, BookOpen, ChevronDown, ChevronUp, Mic, Pause, Play, Settings, Square, Trash2 } from "lucide-react-native";
import { colors, fonts, IconButton, PageEntrance, ScreenHeader, uiStyles } from "../ui";

// 保留策略为单选：0 表示永久保留，3 天为默认
const RETENTION_OPTIONS: DiaryRetentionDays[] = [3, 7, 30, 0];

function retentionLabel(days: DiaryRetentionDays): string {
  return days === 0 ? "永久" : `${days} 天`;
}

function retentionHint(days: DiaryRetentionDays): string {
  if (days === 0) return "不自动清理原始录音";
  if (days === 3) return "转写成功的音频 3 天后自动删除，文本保留";
  return `仅保留最近 ${days} 天的原始录音`;
}

// 兼容旧版本写入的英文错误 + 原生状态码
const NATIVE_ERROR_LABELS: Record<string, string> = {
  capture_runtime_error: "采集运行异常，已自动停止",
  capture_safety_stop: "触发安全策略（空间/电量/温度），采集已停止",
  service_destroy: "采集服务被系统停止",
  models_not_ready: "模型未就绪，请先准备模型",
  audio_record_init_failed: "麦克风初始化失败",
  audio_record_not_initialized: "麦克风不可用",
  vad_init_failed: "语音检测模型初始化失败",
  disk_below_500mb: "存储空间低于 500MB，采集已停止",
  diary_cap_exceeded: "日记音频达到存储上限，采集已停止",
  battery_below_15: "电量低于 15% 且未充电，采集已停止",
  thermal_severe: "设备温度过高，采集已停止",
  ordinary_recording_active: "普通录音进行中，无法采集日记",
};

// 日记“待更新”的内部原因，属于正常提示而非错误
const DIRTY_REASON_LABELS: Record<string, string> = {
  "late-transcript": "有片段在日记生成后才完成转写，点“更新所选日期”可重新生成。",
  "identity-confirmed": "片段身份已手动确认，日记需要重新生成。",
  "voice-profile-reenrolled": "声纹档案已重新录入，日记需要重新生成。",
  "voice-profile-deleted": "声纹档案已删除，日记需要重新生成。",
  "segment-deleted": "片段已删除，日记需要重新生成。",
  "retention-delete": "部分未处理片段已被清理，日记需要重新生成。",
  "language-zh": "日记已切换为中文优先，点“更新所选日期”重新生成。",
};

function errorLabel(error: string): string {
  if (/remote stt network error/i.test(error)) return "远端转写网络错误（旧版本记录，可重试）";
  if (/remote stt timed out/i.test(error)) return "远端转写超时（旧版本记录，可重试）";
  if (/no remote stt api key configured/i.test(error)) return "未配置 SiliconFlow API 密钥（旧版本记录，可重试）";
  if (/^audio_read_error/.test(error)) return "录音读取失败，采集已停止";
  if (/^capture_runtime_error/i.test(error)) {
    const detail = error.split(":").slice(2).join(":").trim();
    return detail ? `采集运行异常（${detail}），已自动停止` : "采集运行异常，已自动停止";
  }
  return NATIVE_ERROR_LABELS[error] ?? error;
}

const DIARY_STATE_LABELS: Record<string, string> = {
  dirty: "有更新待生成",
  generating: "生成中",
  ready: "已生成",
  failed: "生成失败",
  pending: "待处理",
  transcribing: "转写中",
  done: "已完成",
};

const SPEAKER_LABELS: Record<string, string> = {
  matched: "已匹配",
  unknown: "未知",
};

const IDENTITY_LABELS: Record<string, string> = {
  none: "无",
  confirmed_self: "本人",
  confirmed_other: "他人",
};

function stateLabel(state: string): string {
  return DIARY_STATE_LABELS[state] ?? state;
}

function hasDiaryContent(day: DailyDiary): boolean {
  return !!day.content.summaryNeutral.trim()
    || day.content.timeline.length > 0
    || day.content.topics.length > 0
    || day.content.commitments.length > 0
    || day.content.unresolved.length > 0;
}

function ActionButton(props: { title: string; onPress: () => void | Promise<void>; disabled?: boolean; danger?: boolean }) {
  const Icon = props.danger ? Trash2 : ArrowUpRight;
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={props.title} accessibilityState={{ disabled: !!props.disabled }}
      onPress={props.onPress}
      disabled={props.disabled}
      style={[
        styles.button,
        props.danger ? styles.buttonDanger : styles.buttonPrimary,
        props.disabled ? styles.buttonDisabled : null,
      ]}
    >
      <Icon size={15} color={props.danger ? colors.red : colors.accent} />
      <Text style={styles.buttonText}>{props.title}</Text>
    </Pressable>
  );
}

export default function DiaryScreen({ settingsOnly = false }: { settingsOnly?: boolean }) {
  const [status, setStatus] = useState<DiaryRuntimeStatus | null>(null);
  const [days, setDays] = useState<DailyDiary[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [segments, setSegments] = useState<DiarySegment[]>([]);
  const [busy, setBusy] = useState(false);
  const [draining, setDraining] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [showTools, setShowTools] = useState(settingsOnly);
  const [showSegments, setShowSegments] = useState(false);
  const [enrollElapsed, setEnrollElapsed] = useState(0);
  const enrollStartedAtRef = useRef<number | null>(null);
  const autoFinishEnrollRef = useRef(false);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

  // 声纹录入计时，用于提示“建议 15 秒以上”
  const enrollmentActive = !!status?.enrollmentActive;
  useEffect(() => {
    if (!enrollmentActive) {
      enrollStartedAtRef.current = null;
      setEnrollElapsed(0);
      return;
    }
    if (enrollStartedAtRef.current === null) enrollStartedAtRef.current = Date.now();
    const id = setInterval(() => {
      const base = enrollStartedAtRef.current;
      if (base !== null) setEnrollElapsed(Math.floor((Date.now() - base) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [enrollmentActive]);

  // 达到 30 秒上限时自动结束录入，避免样本超长
  useEffect(() => {
    if (!enrollmentActive) {
      autoFinishEnrollRef.current = false;
      return;
    }
    if (enrollElapsed >= 30 && !autoFinishEnrollRef.current) {
      autoFinishEnrollRef.current = true;
      void run(async () => {
        await finishVoiceEnrollmentCapture();
      }, "声纹档案已在本地录入。");
    }
  }, [enrollmentActive, enrollElapsed]);

  const selectedDay = useMemo(() => days.find(item => item.localDate === selectedDate) ?? null, [days, selectedDate]);

  async function refreshAll(dateHint?: string): Promise<void> {
    const [nextStatus, nextDays] = await Promise.all([
      getDiaryRuntimeStatus(),
      listDiaryDays(30),
    ]);
    setStatus(nextStatus);
    setDays(nextDays);

    const nextDate = dateHint ?? (selectedDate || nextDays[0]?.localDate || new Date().toLocaleDateString("en-CA"));
    setSelectedDate(nextDate);
    if (nextDate) {
      setSegments(await listSegmentsForDate(nextDate));
    } else {
      setSegments([]);
    }
  }

  async function run(action: () => Promise<void>, successMessage = ""): Promise<void> {
    try {
      setBusy(true);
      setMessage("");
      await action();
      if (successMessage) setMessage(successMessage);
    } catch (error: any) {
      setMessage(error?.message ?? "操作失败");
    } finally {
      setBusy(false);
      await refreshAll().catch(error => setMessage(error?.message ?? "刷新日记状态失败"));
    }
  }

  useFocusEffect(useCallback(() => {
    refreshAll().catch(error => setMessage(error?.message ?? "加载日记状态失败"));
  }, []));

  // 回到前台时主动刷新一次：后台定时触发的处理不会通知本页，避免界面停在旧计数
  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state === "active") {
        refreshAll().catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // 后台处理期间轮询状态，实时更新队列计数
  useEffect(() => {
    if (!status?.processingActive && !draining) return;
    const id = setInterval(() => {
      refreshAll().catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [status?.processingActive, draining]);

  // 采集或后台处理期间单独轮询待处理数：轻量查询不会被原生转写请求排队拖慢
  useEffect(() => {
    if (!status?.native.active && !status?.processingActive && !draining) return;
    const id = setInterval(() => {
      getDiaryQueueStats()
        .then(queue => setStatus(prev => (prev ? { ...prev, queue } : prev)))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [status?.native.active, status?.processingActive, draining]);

  // 日记生成期间轮询，避免界面一直停留在“生成中”
  const anyGenerating = days.some(item => item.state === "generating");
  useEffect(() => {
    if (!anyGenerating) return;
    const id = setInterval(() => {
      refreshAll().catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [anyGenerating]);

  const androidOnly = Platform.OS !== "android";

  const consentText = "日记采集会录制周围的对话，并把音频上传到 SiliconFlow 进行转写。请确认已获得参与者授权，遵守当地法律法规，并在采集期间保持 Android 常驻通知可见。";

  const configuration = (
    <>
      {!androidOnly && <>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>隐私授权</Text>
        <Text style={styles.body}>{consentText}</Text>
        <View style={styles.rowWrap}>
          <ActionButton
            title={status?.settings.consentGranted ? "撤销授权" : "授予授权"}
            disabled={busy || androidOnly}
            onPress={() => {
              if (status?.settings.consentGranted) {
                Alert.alert("撤销授权？", "在你重新授权之前，采集与云端上传将保持关闭。", [
                  { text: "取消", style: "cancel" },
                  {
                    text: "撤销",
                    style: "destructive",
                    onPress: () => run(async () => {
                      await setDiaryConsentGranted(false);
                    }, "已撤销授权。"),
                  },
                ]);
                return;
              }
              Alert.alert("授予授权？", consentText, [
                { text: "取消", style: "cancel" },
                {
                  text: "我已了解",
                  onPress: () => run(async () => {
                    await setDiaryConsentGranted(true);
                  }, "授权已保存。"),
                },
              ]);
            }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>采集</Text>
        <Text style={styles.body}>
          采集状态：{status?.native.active ? "运行中" : "已停止"} | 暂停：{status?.native.paused ? "是" : "否"} | 模型：{status?.native.modelsReady ? "已就绪" : "未就绪"}
        </Text>
        <Text style={styles.body}>声纹档案：{status?.native.hasSpeakerProfile ? "已存在" : "不存在"}</Text>
        {!!status?.native.error && <Text style={styles.error}>原生错误：{errorLabel(status.native.error)}</Text>}
        <View style={styles.captureActions}>
          {status?.native.active ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={status.native.paused ? "继续采集" : "暂停采集"}
              disabled={busy}
              onPress={() => run(status.native.paused ? resumeDiaryCapture : pauseDiaryCapture,
                status.native.paused ? "日记采集已继续。" : "日记采集已暂停。")}
              style={[styles.primaryButton, busy && styles.controlDisabled]}
            >
              <Text style={styles.primaryButtonText}>{status.native.paused ? "继续采集" : "暂停采集"}</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="开始采集"
              disabled={busy || !status?.settings.consentGranted}
              onPress={() => run(startDiaryCapture, "日记采集已开始。")}
              style={[styles.primaryButton, (busy || !status?.settings.consentGranted) && styles.controlDisabled]}
            >
              {busy
                ? <ActivityIndicator size="small" color={colors.surface} />
                : <Text style={styles.primaryButtonText}>开始采集</Text>}
            </Pressable>
          )}
          {status?.native.active && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="停止采集"
              onPress={() => run(stopDiaryCapture, "日记采集已停止。")}
              style={styles.stopButtonLarge}
            >
              <Text style={styles.stopButtonText}>停止采集</Text>
            </Pressable>
          )}
        </View>
        <View style={styles.captureSecondary}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="准备模型"
            disabled={busy || !!status?.native.active}
            onPress={() => run(prepareDiaryModels, "模型已准备。")}
            style={[styles.secondaryButton, (busy || !!status?.native.active) && styles.controlDisabled]}
          >
            <Text style={styles.secondaryButtonText}>准备模型</Text>
          </Pressable>
        </View>
        {!status?.settings.consentGranted && (
          <Text style={styles.caption}>开始采集前需要先在「隐私授权」中授予授权。</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>声纹录入（仅本机）</Text>
        <Text style={styles.body}>录制 15-30 秒的连续独处语音（安静环境下说话，避免静音或多人交谈）。临时音频在成功或失败后都会删除。</Text>
        <View style={styles.rowWrap}>
          <ActionButton title="开始录入" disabled={busy || androidOnly || enrollmentActive || !!status?.native.active} onPress={() => run(startVoiceEnrollmentCapture, "声纹录入已开始。")} />
          <ActionButton title="完成录入" disabled={busy || androidOnly || !enrollmentActive || enrollElapsed < 15} onPress={() => run(async () => { await finishVoiceEnrollmentCapture(); }, "声纹档案已在本地录入。")} />
          <ActionButton title="取消录入" disabled={busy || androidOnly || !enrollmentActive} onPress={() => run(cancelVoiceEnrollmentCapture, "已取消录入。")} />
          <ActionButton title="删除声纹档案" danger disabled={busy || androidOnly || !status?.native.hasSpeakerProfile} onPress={() => {
            Alert.alert("删除声纹档案？", "这会移除本机的说话人模板，并停止自动匹配。", [
              { text: "取消", style: "cancel" },
              { text: "删除", style: "destructive", onPress: () => run(deleteVoiceProfile, "声纹档案已删除。") },
            ]);
          }} />
        </View>
        {enrollmentActive && (
          <Text style={styles.caption}>正在录音 {enrollElapsed}s（需 15-30s，满 30s 自动结束）</Text>
        )}
        {!enrollmentActive && !!status?.native.active && (
          <Text style={styles.caption}>请先停止日记采集，再录入声纹。</Text>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>处理队列</Text>
        <Text style={styles.body}>
          待处理 {status?.queue.pending ?? 0} | 失败 {status?.queue.failed ?? 0} | 可重试 {status?.queue.retryableFailed ?? 0} | 已完成 {status?.queue.done ?? 0}
        </Text>
        <View style={styles.rowWrap}>
          <ActionButton title="导入并处理" disabled={busy || androidOnly || !status?.settings.consentGranted} onPress={() => run(async () => {
            await handleDiaryForeground();
            await processDiaryQueue(8);
          }, "队列已处理。")} />
        </View>
      </View>
      </>}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>保留策略</Text>
        <Text style={styles.body}>原始录音保留时长（单选）：</Text>
        <View style={styles.retentionList}>
          {RETENTION_OPTIONS.map(daysOption => {
            const selected = status?.settings.retentionDays === daysOption;
            return (
              <Pressable
                key={String(daysOption)}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: busy }}
                disabled={busy}
                onPress={() => run(async () => {
                  await setDiaryRetentionPolicy(daysOption);
                }, daysOption === 0 ? "已设为永久保留。" : `保留时长已设为 ${daysOption} 天。`)}
                style={[styles.retentionRow, selected && styles.retentionRowActive]}
              >
                <View style={[styles.radio, selected && styles.radioActive]}>
                  {selected && <View style={styles.radioDot} />}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.retentionTitle, selected && { color: colors.accent }]}>{retentionLabel(daysOption)}</Text>
                  <Text style={styles.caption}>{retentionHint(daysOption)}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        {status?.settings.retentionDays === 0 ? (
          <Text style={styles.caption}>当前为永久保留，清理按钮不会删除任何数据。</Text>
        ) : (
          <Text style={styles.caption}>超过 {status?.settings.retentionDays} 天的已转写音频会自动删除，转写文本与日记内容保留。</Text>
        )}
        {!androidOnly && <View style={styles.rowWrap}>
          <ActionButton
            title="应用保留策略"
            disabled={busy || androidOnly || status?.settings.retentionDays === 0}
            onPress={() => run(async () => {
              const plan = await getRetentionPlan();
              await applyRetentionPlan({ allowUnprocessedDelete: false });
            }, "已清理过期音频，转写文本已保留。")}
          />
          <ActionButton
            title="强制清理积压"
            danger
            disabled={busy || androidOnly}
            onPress={() => {
              Alert.alert("强制删除未处理片段？", "这可能删除尚未转写的证据。", [
                { text: "取消", style: "cancel" },
                {
                  text: "删除",
                  style: "destructive",
                  onPress: () => run(async () => {
                    await applyRetentionPlan({ allowUnprocessedDelete: true });
                  }, "强制清理完成。"),
                },
              ]);
            }}
          />
        </View>}
      </View>
    </>
  );

  return (
    <View style={uiStyles.page}>
      <ScreenHeader title={settingsOnly ? "日记设置" : "日记"} back={settingsOnly} />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.caption}>{androidOnly ? "后台采集需要 Android 设备" : status?.platformMessage ?? "正在加载采集状态…"}</Text>
        {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
        {!settingsOnly && <>
          {!androidOnly && <View style={styles.captureRow}>
            <Mic size={20} color={status?.native.active ? colors.red : colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>{status?.native.active ? status.native.paused ? "已暂停" : "日记采集中" : "采集已停止"}</Text>
              <Text style={styles.caption}>{status?.queue.pending ?? 0} 个待处理 · {status?.queue.failed ?? 0} 个失败</Text>
            </View>
            {status?.native.active ? <>
              <IconButton icon={status.native.paused ? Play : Pause} label={status.native.paused ? "继续日记采集" : "暂停日记采集"} disabled={busy}
                onPress={() => { void run(status.native.paused ? resumeDiaryCapture : pauseDiaryCapture); }} />
              <IconButton icon={Square} label="停止日记采集" onPress={() => { void run(stopDiaryCapture, "日记采集已停止。"); }} />
            </> : status?.settings.consentGranted && status.native.modelsReady
              ? <IconButton icon={Mic} label="开始日记采集" disabled={busy} onPress={() => { void run(startDiaryCapture); }} />
              : <ActionButton title="设置日记功能" disabled={busy || !status} onPress={() => navigation.navigate("DiarySettings")} />}
          </View>}
          {!!status?.native.error && <Text style={styles.error}>{errorLabel(status.native.error)}</Text>}
          {!androidOnly && !!(status?.queue.pending || status?.processingActive || draining) && (
            <ActionButton
              title={status?.processingActive || draining ? "正在后台处理…" : "处理待处理片段"}
              disabled={busy || !status?.settings.consentGranted}
              onPress={() => {
                if (status?.processingActive || draining) {
                  setMessage("队列正在后台处理，请稍候…");
                  return;
                }
                setMessage("已在后台开始处理所有待处理片段…");
                setDraining(true);
                void processAllDiarySegments()
                  .then(result => {
                    if (result.skipped) {
                      setMessage("队列正在处理中，请稍候。");
                      return;
                    }
                    setMessage(`处理完成：成功 ${result.processed}，失败 ${result.failed}，清理无意义 ${result.deleted}。`);
                  })
                  .catch(error => setMessage(error?.message ?? "处理失败"))
                  .finally(() => {
                    setDraining(false);
                    void refreshAll().catch(() => {});
                  });
              }}
            />
          )}
          <PageEntrance key={`${selectedDate}-${selectedDay?.state}`}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>每日日记</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
          {days.map(day => (
            <Pressable accessibilityRole="tab" accessibilityState={{ selected: day.localDate === selectedDate }} key={day.localDate} style={[styles.dayPill, day.localDate === selectedDate ? styles.dayPillActive : null]} onPress={() => {
              setSelectedDate(day.localDate);
              listSegmentsForDate(day.localDate).then(setSegments).catch(() => {});
            }}>
              <Text style={styles.dayPillText}>{day.localDate.slice(5)}</Text>
              <Text style={styles.caption}>{stateLabel(day.state)}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={styles.journalDate}>{selectedDate || new Date().toLocaleDateString("en-CA")}</Text>
        {days.length === 0 ? <View style={styles.emptyDiary}><BookOpen size={30} color={colors.muted} strokeWidth={1.3} /><Text style={styles.sectionTitle}>暂无日记</Text></View> : null}
        {selectedDate && !androidOnly ? (
          <View style={styles.rowWrap}>
            <ActionButton
              title={selectedDay ? "更新所选日期" : "生成所选日期"}
              disabled={busy || androidOnly || !status?.settings.consentGranted}
              onPress={() => run(async () => {
                await generateDailyDiary(selectedDate);
              }, `${selectedDate} 的日记已生成。`)}
            />
          </View>
        ) : null}
        {selectedDay && (selectedDay.state === "ready" || hasDiaryContent(selectedDay)) ? (
          <View style={{ gap: 24, paddingVertical: 12 }}>
            <Text style={[styles.journal, { fontSize: 24, lineHeight: 34 }]}>{selectedDay.content.summaryNeutral}</Text>
            {[
              { title: "时间线", items: selectedDay.content.timeline.map(item => ({ text: [item.timeHint, item.event].filter(Boolean).join(" - "), sources: item.sourceSegmentIds })) },
              { title: "主题", items: selectedDay.content.topics.map(item => ({ text: [item.topic, item.details].filter(Boolean).join("："), sources: item.sourceSegmentIds })) },
              { title: "承诺", items: selectedDay.content.commitments.map(item => ({ text: [item.item, item.owner, item.due].filter(Boolean).join(" - "), sources: item.sourceSegmentIds })) },
              { title: "待解决", items: selectedDay.content.unresolved.map(item => ({ text: item.item, sources: item.sourceSegmentIds })) },
            ].filter(section => section.items.length > 0).map(section => (
              <View key={section.title} style={{ gap: 8 }}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((item, index) => (
                  <View key={`${section.title}-${index}`} style={{ gap: 4 }}>
                    <Text style={styles.journal}>{item.text}</Text>
                    <Text style={styles.caption}>来源：{item.sources.join(", ")}</Text>
                  </View>
                ))}
              </View>
            ))}
            <Text style={styles.caption}>{selectedDay.content.caveat}</Text>
          </View>
        ) : selectedDay ? (
          <Text style={styles.caption}>日记状态：{stateLabel(selectedDay.state)}</Text>
        ) : null}
        {selectedDay?.lastError ? (
          DIRTY_REASON_LABELS[selectedDay.lastError]
            ? <Text style={styles.caption}>{DIRTY_REASON_LABELS[selectedDay.lastError]}</Text>
            : <Text style={styles.error}>{errorLabel(selectedDay.lastError)}</Text>
        ) : null}
      </View>
          </PageEntrance>

      <Pressable accessibilityRole="button" accessibilityLabel="查看片段" accessibilityState={{ expanded: showSegments }}
        onPress={() => setShowSegments(value => !value)} style={styles.panelToggle}>
        <Text style={styles.sectionTitle}>片段 · {segments.length}</Text>
        {showSegments ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
      </Pressable>
      {showSegments && <PageEntrance><View style={styles.card}>
        {segments.length === 0 ? <Text style={styles.body}>当天没有导入的片段。</Text> : null}
        {segments.map(segment => (
          <View key={segment.id} style={styles.segmentBox}>
            <Text style={styles.segmentTitle}>[{segment.id}] {stateLabel(segment.state)}</Text>
            <Text style={styles.body}>来源时间：{segment.startTime} - {segment.endTime}</Text>
            <Text style={styles.body}>身份：自动={SPEAKER_LABELS[segment.speakerAuto] ?? segment.speakerAuto} 手动={IDENTITY_LABELS[segment.manualIdentity] ?? segment.manualIdentity}</Text>
            {segment.lastError ? <Text style={styles.error}>错误：{errorLabel(segment.lastError)}</Text> : null}
            {segment.transcript ? <Text style={styles.body}>转写：{segment.transcript.slice(0, 280)}</Text> : null}
            <View style={styles.rowWrap}>
              <ActionButton title="重试" disabled={busy || segment.state !== "failed"} onPress={() => run(async () => {
                await retrySegment(segment.id);
                await processDiaryQueue(3);
              }, `已重试 ${segment.id}。`)} />
              <ActionButton title="确认本人" disabled={busy} onPress={() => {
                Alert.alert("确认身份？", "手动确认仅应用于该片段的证据。", [
                  { text: "取消", style: "cancel" },
                  {
                    text: "确认",
                    onPress: () => run(
                      () => confirmSegmentIdentity(segment.id, "confirmed_self", "Manual confirmation"),
                      "已保存本人确认。",
                    ),
                  },
                ]);
              }} />
              <ActionButton title="确认他人" disabled={busy} onPress={() => {
                Alert.alert("确认身份？", "手动确认仅应用于该片段的证据。", [
                  { text: "取消", style: "cancel" },
                  {
                    text: "确认",
                    onPress: () => run(
                      () => confirmSegmentIdentity(segment.id, "confirmed_other", "Manual confirmation"),
                      "已保存他人确认。",
                    ),
                  },
                ]);
              }} />
              <ActionButton title="清除确认" disabled={busy} onPress={() => run(() => confirmSegmentIdentity(segment.id, "none", ""), "已清除手动确认。")} />
              <ActionButton
                title="删除片段"
                danger
                disabled={busy}
                onPress={() => {
                  Alert.alert("删除片段？", "删除该片段后，已生成的日记内容将失效，需要重新生成。", [
                    { text: "取消", style: "cancel" },
                    {
                      text: "删除",
                      style: "destructive",
                      onPress: () => run(() => deleteSingleSegment(segment.id, true), `已删除 ${segment.id}。`),
                    },
                  ]);
                }}
              />
            </View>
          </View>
        ))}
      </View></PageEntrance>}
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate("DiarySettings")} style={styles.panelToggle}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><Settings size={18} color={colors.muted} /><Text style={styles.sectionTitle}>日记设置</Text></View>
        <ArrowUpRight size={18} color={colors.muted} />
      </Pressable>
      </>}
      {settingsOnly && <>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTools }} onPress={() => setShowTools(value => !value)} style={styles.panelToggle}>
          <Text style={styles.sectionTitle}>隐私与采集</Text>
          {showTools ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
        </Pressable>
        {showTools && <PageEntrance>{configuration}</PageEntrance>}
      </>}

      {settingsOnly && !androidOnly && <View style={styles.card}>
        <Text style={styles.sectionTitle}>数据清理</Text>
        <Text style={styles.body}>采集中时无法执行删除操作。</Text>
        <View style={styles.rowWrap}>
          <ActionButton
            title="清理失败片段"
            danger
            disabled={busy || androidOnly || !!status?.native.active}
            onPress={() => {
              Alert.alert("清理失败片段？", "将删除所有失败的片段及其原始音频，不影响已生成的日记内容。", [
                { text: "取消", style: "cancel" },
                {
                  text: "删除",
                  style: "destructive",
                  onPress: () => run(async () => {
                    const { deleted } = await deleteFailedSegments();
                    setMessage(deleted ? `已清理 ${deleted} 个失败片段。` : "没有需要清理的失败片段。");
                  }),
                },
              ]);
            }}
          />
          <ActionButton
            title="仅清理原始音频"
            danger
            disabled={busy || androidOnly}
            onPress={() => {
              Alert.alert("清理原始音频？", "将删除所有原始日记音频，但保留已生成的每日日记内容。", [
                { text: "取消", style: "cancel" },
                {
                  text: "删除",
                  style: "destructive",
                  onPress: () => run(async () => {
                    await purgeDiaryData(false);
                  }, "原始日记音频已清除。"),
                },
              ]);
            }}
          />
          <ActionButton
            title="清理全部衍生数据"
            danger
            disabled={busy || androidOnly}
            onPress={() => {
              Alert.alert("清理全部日记数据？", "将删除原始音频及所有衍生日记记录。", [
                { text: "取消", style: "cancel" },
                {
                  text: "全部删除",
                  style: "destructive",
                  onPress: () => run(async () => {
                    await purgeDiaryData(true);
                  }, "全部日记数据已清除。"),
                },
              ]);
            }}
          />
        </View>
      </View>}
      </ScrollView>
    </View>
  );
}

export function DiarySettingsScreen() { return <DiaryScreen settingsOnly />; }

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 24, paddingBottom: 32,
    gap: 12,
  },
  title: {
    fontSize: 26,
    fontWeight: "700",
    color: "#1B1F24",
  },
  caption: {
    fontSize: 12, fontFamily: fonts.body,
    color: colors.muted, lineHeight: 19,
  },
  card: {
    borderBottomWidth: 1,
    borderColor: colors.line,
    paddingVertical: 20,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontFamily: fonts.strong,
    color: colors.text,
  },
  body: {
    fontSize: 14, fontFamily: fonts.body, lineHeight: 22,
    color: colors.text,
  },
  rowWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  button: {
    minHeight: 44, flexDirection: "row", gap: 7, alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  buttonPrimary: {
    backgroundColor: colors.soft,
  },
  buttonDanger: {
    backgroundColor: "#FBEDEA",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  buttonText: {
    color: colors.text, fontFamily: fonts.strong,
    fontSize: 12,
  },
  captureActions: {
    gap: 10,
    marginTop: 4,
  },
  primaryButton: {
    minHeight: 48,
    borderRadius: 8,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: colors.surface,
    fontFamily: fonts.strong,
    fontSize: 15,
  },
  stopButtonLarge: {
    minHeight: 48,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.red,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButtonText: {
    color: colors.red,
    fontFamily: fonts.strong,
    fontSize: 15,
  },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    color: colors.text,
    fontFamily: fonts.strong,
    fontSize: 13,
  },
  captureSecondary: {
    flexDirection: "row",
  },
  controlDisabled: {
    opacity: 0.45,
  },
  retentionList: {
    gap: 8,
  },
  retentionRow: {
    minHeight: 54,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: colors.surface,
  },
  retentionRowActive: {
    borderColor: colors.accent,
    backgroundColor: colors.soft,
  },
  retentionTitle: {
    color: colors.text,
    fontFamily: fonts.strong,
    fontSize: 14,
    marginBottom: 2,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
  },
  radioActive: {
    borderColor: colors.accent,
  },
  radioDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  message: {
    fontSize: 13,
    color: colors.accent,
  },
  error: {
    fontSize: 12,
    color: "#B42318",
  },
  dayPill: {
    minHeight: 56, minWidth: 76, gap: 4,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#FFFFFF",
  },
  dayPillActive: {
    backgroundColor: colors.soft,
    borderColor: colors.accent,
  },
  dayPillText: {
    color: colors.text, fontFamily: fonts.strong,
    fontSize: 12,
    fontWeight: "600",
  },
  segmentBox: {
    borderWidth: 1,
    borderColor: "#E2E8F0",
    borderRadius: 8,
    padding: 10,
    gap: 6,
    backgroundColor: "#FCFCFD",
  },
  segmentTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#101828",
  },
  journal: { fontFamily: fonts.reading, fontSize: 20, lineHeight: 30, color: colors.text },
  journalDate: { fontFamily: fonts.reading, fontSize: 30, color: colors.text, marginTop: 8 },
  emptyDiary: { gap: 16, paddingVertical: 40 },
  captureRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: colors.line },
  panelToggle: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, borderBottomWidth: 1, borderBottomColor: colors.line },
});
