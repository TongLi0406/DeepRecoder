import { useCallback, useMemo, useState } from "react";
import {
  Alert,
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
  deleteSingleSegment,
  deleteVoiceProfile,
  finishVoiceEnrollmentCapture,
  generateDailyDiary,
  getDiaryRuntimeStatus,
  getRetentionPlan,
  handleDiaryForeground,
  listDiaryDays,
  listSegmentsForDate,
  pauseDiaryCapture,
  prepareDiaryModels,
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

const RETENTION_OPTIONS: DiaryRetentionDays[] = [1, 7, 30];

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
  const [message, setMessage] = useState<string>("");
  const [showTools, setShowTools] = useState(settingsOnly);
  const [showSegments, setShowSegments] = useState(false);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();

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
      setMessage(error?.message ?? "Operation failed");
    } finally {
      setBusy(false);
      await refreshAll().catch(error => setMessage(error?.message ?? "Failed to refresh diary state"));
    }
  }

  useFocusEffect(useCallback(() => {
    refreshAll().catch(error => setMessage(error?.message ?? "Failed to load diary state"));
  }, []));

  const androidOnly = Platform.OS !== "android";

  const consentText = "Diary capture records nearby conversations and uploads audio to SiliconFlow for transcription. Confirm participant authorization, follow local laws, and keep the ongoing Android notification visible while capture is running.";

  const configuration = (
    <>
      {!androidOnly && <>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Privacy Consent</Text>
        <Text style={styles.body}>{consentText}</Text>
        <View style={styles.rowWrap}>
          <ActionButton
            title={status?.settings.consentGranted ? "Revoke Consent" : "Grant Consent"}
            disabled={busy || androidOnly}
            onPress={() => {
              if (status?.settings.consentGranted) {
                Alert.alert("Revoke consent?", "Capture and cloud upload must remain disabled until you consent again.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Revoke",
                    style: "destructive",
                    onPress: () => run(async () => {
                      await setDiaryConsentGranted(false);
                    }, "Consent revoked."),
                  },
                ]);
                return;
              }
              Alert.alert("Grant consent?", consentText, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "I understand",
                  onPress: () => run(async () => {
                    await setDiaryConsentGranted(true);
                  }, "Consent saved."),
                },
              ]);
            }}
          />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Capture</Text>
        <Text style={styles.body}>
          Active: {String(status?.native.active ?? false)} | Paused: {String(status?.native.paused ?? false)} | Models: {String(status?.native.modelsReady ?? false)}
        </Text>
        <Text style={styles.body}>Speaker profile exists: {String(status?.native.hasSpeakerProfile ?? false)}</Text>
        {!!status?.native.error && <Text style={styles.error}>Native error: {status.native.error}</Text>}
        <View style={styles.rowWrap}>
          <ActionButton title="Prepare Models" disabled={busy || androidOnly} onPress={() => run(prepareDiaryModels, "Models prepared.")} />
          <ActionButton title="Start" disabled={busy || androidOnly || !status?.settings.consentGranted} onPress={() => run(startDiaryCapture, "Diary capture started.")} />
          <ActionButton title="Pause" disabled={busy || androidOnly || !status?.native.active || !!status?.native.paused} onPress={() => run(pauseDiaryCapture, "Diary capture paused.")} />
          <ActionButton title="Resume" disabled={busy || androidOnly || !status?.native.active || !status?.native.paused} onPress={() => run(resumeDiaryCapture, "Diary capture resumed.")} />
          <ActionButton title="Stop" disabled={busy || androidOnly || !status?.native.active} onPress={() => run(stopDiaryCapture, "Diary capture stopped.")} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Enrollment (Local Only)</Text>
        <Text style={styles.body}>Record a 15-30s solo sample. Temporary audio is deleted after success or failure.</Text>
        <View style={styles.rowWrap}>
          <ActionButton title="Start Enrollment" disabled={busy || androidOnly || !!status?.enrollmentActive} onPress={() => run(startVoiceEnrollmentCapture, "Enrollment recording started.")} />
          <ActionButton title="Finish Enrollment" disabled={busy || androidOnly || !status?.enrollmentActive} onPress={() => run(async () => { await finishVoiceEnrollmentCapture(); }, "Speaker profile enrolled locally.")} />
          <ActionButton title="Cancel Enrollment" disabled={busy || androidOnly || !status?.enrollmentActive} onPress={() => run(cancelVoiceEnrollmentCapture, "Enrollment cancelled." )} />
          <ActionButton title="Delete Voice Profile" danger disabled={busy || androidOnly || !status?.native.hasSpeakerProfile} onPress={() => {
            Alert.alert("Delete voice profile?", "This removes local speaker template and stops auto matching.", [
              { text: "Cancel", style: "cancel" },
              { text: "Delete", style: "destructive", onPress: () => run(deleteVoiceProfile, "Speaker profile deleted.") },
            ]);
          }} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Processing Queue</Text>
        <Text style={styles.body}>
          Pending {status?.queue.pending ?? 0} | Failed {status?.queue.failed ?? 0} | Retryable {status?.queue.retryableFailed ?? 0} | Done {status?.queue.done ?? 0}
        </Text>
        <View style={styles.rowWrap}>
          <ActionButton title="Import + Process" disabled={busy || androidOnly || !status?.settings.consentGranted} onPress={() => run(async () => {
            await handleDiaryForeground();
            await processDiaryQueue(8);
          }, "Queue drained." )} />
        </View>
      </View>
      </>}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Retention</Text>
        <Text style={styles.body}>Keep raw audio for:</Text>
        <View style={uiStyles.segmented}>
          {RETENTION_OPTIONS.map(daysOption => (
            <Pressable
              key={String(daysOption)}
              accessibilityRole="radio" accessibilityState={{ checked: status?.settings.retentionDays === daysOption }}
              style={[uiStyles.segment, status?.settings.retentionDays === daysOption && uiStyles.segmentActive]}
              disabled={busy}
              onPress={() => run(async () => {
                await setDiaryRetentionPolicy(daysOption);
              }, `Retention set to ${daysOption} day(s).`)}
            ><Text style={uiStyles.segmentText}>{daysOption} day{daysOption > 1 ? "s" : ""}</Text></Pressable>
          ))}
        </View>
        {!androidOnly && <View style={styles.rowWrap}>
          <ActionButton
            title="Apply Retention"
            disabled={busy || androidOnly}
            onPress={() => run(async () => {
              const plan = await getRetentionPlan();
              if (plan.blockedUnprocessedSegmentIds.length) {
                throw new Error(`Backlog exists (${plan.blockedUnprocessedSegmentIds.length} unprocessed). Confirm explicit purge if required.`);
              }
              await applyRetentionPlan({ allowUnprocessedDelete: false });
            }, "Retention cleanup applied.")}
          />
          <ActionButton
            title="Force Purge Backlog"
            danger
            disabled={busy || androidOnly}
            onPress={() => {
              Alert.alert("Force delete unprocessed segments?", "This can remove not-yet-transcribed evidence.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => run(async () => {
                    await applyRetentionPlan({ allowUnprocessedDelete: true });
                  }, "Forced retention purge finished."),
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
      <ScreenHeader title={settingsOnly ? "Diary Settings" : "Diary"} back={settingsOnly} />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.caption}>{androidOnly ? "Background capture requires Android" : status?.platformMessage ?? "Loading capture status..."}</Text>
        {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
        {!settingsOnly && <>
          {!androidOnly && <View style={styles.captureRow}>
            <Mic size={20} color={status?.native.active ? colors.red : colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>{status?.native.active ? status.native.paused ? "Paused" : "Diary capture active" : "Capture stopped"}</Text>
              <Text style={styles.caption}>{status?.queue.pending ?? 0} pending · {status?.queue.failed ?? 0} failed</Text>
            </View>
            {status?.native.active ? <>
              <IconButton icon={status.native.paused ? Play : Pause} label={status.native.paused ? "Resume Diary" : "Pause Diary"} disabled={busy}
                onPress={() => { void run(status.native.paused ? resumeDiaryCapture : pauseDiaryCapture); }} />
              <IconButton icon={Square} label="Stop Diary" disabled={busy} onPress={() => { void run(async () => { await stopDiaryCapture(); await handleDiaryForeground(); }); }} />
            </> : status?.settings.consentGranted && status.native.modelsReady
              ? <IconButton icon={Mic} label="Start Diary" disabled={busy} onPress={() => { void run(startDiaryCapture); }} />
              : <ActionButton title="Set Up Diary" disabled={busy || !status} onPress={() => navigation.navigate("DiarySettings")} />}
          </View>}
          {!!status?.native.error && <Text style={styles.error}>{status.native.error}</Text>}
          {!androidOnly && !!status?.queue.pending && <ActionButton title="Process Pending Segments" disabled={busy || !status.settings.consentGranted}
            onPress={() => run(async () => { await handleDiaryForeground(); await processDiaryQueue(8); })} />}
          <PageEntrance key={`${selectedDate}-${selectedDay?.state}`}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Daily Diaries</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 8 }}>
          {days.map(day => (
            <Pressable accessibilityRole="tab" accessibilityState={{ selected: day.localDate === selectedDate }} key={day.localDate} style={[styles.dayPill, day.localDate === selectedDate ? styles.dayPillActive : null]} onPress={() => {
              setSelectedDate(day.localDate);
              listSegmentsForDate(day.localDate).then(setSegments).catch(() => {});
            }}>
              <Text style={styles.dayPillText}>{day.localDate.slice(5)}</Text>
              <Text style={styles.caption}>{day.state}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <Text style={styles.journalDate}>{selectedDate || new Date().toLocaleDateString("en-CA")}</Text>
        {days.length === 0 ? <View style={styles.emptyDiary}><BookOpen size={30} color={colors.muted} strokeWidth={1.3} /><Text style={styles.sectionTitle}>No diary entries yet</Text></View> : null}
        {selectedDate && !androidOnly ? (
          <View style={styles.rowWrap}>
            <ActionButton
              title={selectedDay ? "Update Selected Day" : "Generate Selected Day"}
              disabled={busy || androidOnly || !status?.settings.consentGranted}
              onPress={() => run(async () => {
                await generateDailyDiary(selectedDate);
              }, `Daily diary generated for ${selectedDate}.`)}
            />
          </View>
        ) : null}
        {selectedDay?.state === "ready" ? (
          <View style={{ gap: 24, paddingVertical: 12 }}>
            <Text style={[styles.journal, { fontSize: 24, lineHeight: 34 }]}>{selectedDay.content.summaryNeutral}</Text>
            {[
              { title: "Timeline", items: selectedDay.content.timeline.map(item => ({ text: [item.timeHint, item.event].filter(Boolean).join(" - "), sources: item.sourceSegmentIds })) },
              { title: "Topics", items: selectedDay.content.topics.map(item => ({ text: [item.topic, item.details].filter(Boolean).join(": "), sources: item.sourceSegmentIds })) },
              { title: "Commitments", items: selectedDay.content.commitments.map(item => ({ text: [item.item, item.owner, item.due].filter(Boolean).join(" - "), sources: item.sourceSegmentIds })) },
              { title: "Unresolved", items: selectedDay.content.unresolved.map(item => ({ text: item.item, sources: item.sourceSegmentIds })) },
            ].filter(section => section.items.length > 0).map(section => (
              <View key={section.title} style={{ gap: 8 }}>
                <Text style={styles.sectionTitle}>{section.title}</Text>
                {section.items.map((item, index) => (
                  <View key={`${section.title}-${index}`} style={{ gap: 4 }}>
                    <Text style={styles.journal}>{item.text}</Text>
                    <Text style={styles.caption}>Sources: {item.sources.join(", ")}</Text>
                  </View>
                ))}
              </View>
            ))}
            <Text style={styles.caption}>{selectedDay.content.caveat}</Text>
          </View>
        ) : selectedDay ? (
          <Text style={styles.caption}>Daily diary: {selectedDay.state}</Text>
        ) : null}
        {selectedDay?.lastError ? <Text style={styles.error}>{selectedDay.lastError}</Text> : null}
      </View>
          </PageEntrance>

      <Pressable accessibilityRole="button" accessibilityLabel="Review Segments" accessibilityState={{ expanded: showSegments }}
        onPress={() => setShowSegments(value => !value)} style={styles.panelToggle}>
        <Text style={styles.sectionTitle}>Segments · {segments.length}</Text>
        {showSegments ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
      </Pressable>
      {showSegments && <PageEntrance><View style={styles.card}>
        {segments.length === 0 ? <Text style={styles.body}>No segment imported for this day.</Text> : null}
        {segments.map(segment => (
          <View key={segment.id} style={styles.segmentBox}>
            <Text style={styles.segmentTitle}>[{segment.id}] {segment.state}</Text>
            <Text style={styles.body}>Source: {segment.startTime} - {segment.endTime}</Text>
            <Text style={styles.body}>Identity: auto={segment.speakerAuto} manual={segment.manualIdentity}</Text>
            {segment.lastError ? <Text style={styles.error}>Error: {segment.lastError}</Text> : null}
            {segment.transcript ? <Text style={styles.body}>Transcript: {segment.transcript.slice(0, 280)}</Text> : null}
            <View style={styles.rowWrap}>
              <ActionButton title="Retry" disabled={busy || segment.state !== "failed"} onPress={() => run(async () => {
                await retrySegment(segment.id);
                await processDiaryQueue(3);
              }, `Retried ${segment.id}.`)} />
              <ActionButton title="Confirm Self" disabled={busy} onPress={() => {
                Alert.alert("Confirm identity?", "Apply manual self confirmation only to this segment evidence.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Confirm",
                    onPress: () => run(
                      () => confirmSegmentIdentity(segment.id, "confirmed_self", "Manual confirmation"),
                      "Manual self confirmation saved.",
                    ),
                  },
                ]);
              }} />
              <ActionButton title="Confirm Other" disabled={busy} onPress={() => {
                Alert.alert("Confirm identity?", "Apply manual non-self confirmation only to this segment evidence.", [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Confirm",
                    onPress: () => run(
                      () => confirmSegmentIdentity(segment.id, "confirmed_other", "Manual confirmation"),
                      "Manual other confirmation saved.",
                    ),
                  },
                ]);
              }} />
              <ActionButton title="Clear Confirm" disabled={busy} onPress={() => run(() => confirmSegmentIdentity(segment.id, "none", ""), "Manual confirmation cleared.")} />
              <ActionButton
                title="Delete Segment"
                danger
                disabled={busy}
                onPress={() => {
                  Alert.alert("Delete segment?", "Delete this segment and invalidate derived daily output until regeneration.", [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Delete",
                      style: "destructive",
                      onPress: () => run(() => deleteSingleSegment(segment.id, true), `Deleted ${segment.id}.`),
                    },
                  ]);
                }}
              />
            </View>
          </View>
        ))}
      </View></PageEntrance>}
      <Pressable accessibilityRole="button" onPress={() => navigation.navigate("DiarySettings")} style={styles.panelToggle}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><Settings size={18} color={colors.muted} /><Text style={styles.sectionTitle}>Diary Settings</Text></View>
        <ArrowUpRight size={18} color={colors.muted} />
      </Pressable>
      </>}
      {settingsOnly && <>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showTools }} onPress={() => setShowTools(value => !value)} style={styles.panelToggle}>
          <Text style={styles.sectionTitle}>Privacy & Capture</Text>
          {showTools ? <ChevronUp size={18} color={colors.muted} /> : <ChevronDown size={18} color={colors.muted} />}
        </Pressable>
        {showTools && <PageEntrance>{configuration}</PageEntrance>}
      </>}

      {settingsOnly && !androidOnly && <View style={styles.card}>
        <Text style={styles.sectionTitle}>Data Purge</Text>
        <Text style={styles.body}>Delete actions are blocked while capture is active.</Text>
        <View style={styles.rowWrap}>
          <ActionButton
            title="Purge Raw Audio Only"
            danger
            disabled={busy || androidOnly}
            onPress={() => {
              Alert.alert("Purge raw audio?", "Delete all raw diary audio while keeping generated daily diary content.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => run(async () => {
                    await purgeDiaryData(false);
                  }, "Raw diary audio removed."),
                },
              ]);
            }}
          />
          <ActionButton
            title="Purge All Derived Data"
            danger
            disabled={busy || androidOnly}
            onPress={() => {
              Alert.alert("Purge all diary data?", "Delete raw audio and all derived diary records.", [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete all",
                  style: "destructive",
                  onPress: () => run(async () => {
                    await purgeDiaryData(true);
                  }, "All diary data removed."),
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
