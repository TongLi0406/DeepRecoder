import { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { useNavigation, usePreventRemove, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { StudentSummary, TeacherSummary, MeetingSummary } from "../types";
import { getSessionById, getSessionPartialSummary, updateSessionPhase } from "../services/storage";
import { startProcessing, abortProcessing, getQueueState, addQueueListener } from "../services/processingQueue";
import { exportDocument, sessionToHtml, sessionToMarkdown } from "../services/export";
import { Check, ChevronDown, ChevronRight, Download, FileText, RotateCcw } from "lucide-react-native";
import { colors, fonts, IconButton, PageEntrance, ScreenHeader, uiStyles } from "../ui";

type Nav = NativeStackNavigationProp<RootStackParamList, "Summary">;
type Route = RouteProp<RootStackParamList, "Summary">;

function StudentSummaryView({ summary }: { summary: StudentSummary }) {
  return (
    <>
      <Text style={styles.section}>Knowledge Points</Text>
      {summary.knowledgePoints.length === 0 && (
        <Text style={styles.emptyText}>No knowledge points identified</Text>
      )}
      {summary.knowledgePoints.map((kp) => (
        <View key={kp.id} style={styles.card}>
          <Text style={styles.cardTitle}>{kp.name}</Text>
          <Text style={styles.cardDesc}>{kp.description}</Text>
          <Text style={styles.cardHint}>
            Tip: {(kp as any).masteryHint ?? kp.category}
          </Text>
        </View>
      ))}

      <Text style={styles.section}>Problem-Solving Approaches</Text>
      {summary.problemSolvingApproaches.length === 0 && (
        <Text style={styles.emptyText}>No approaches identified</Text>
      )}
      {summary.problemSolvingApproaches.map((pa) => (
        <View key={pa.id} style={styles.card}>
          <Text style={styles.cardTitle}>{pa.approach}</Text>
          <Text style={styles.cardDesc}>{pa.procedure}</Text>
        </View>
      ))}

      {summary.interLessonConnections.length > 0 && (
        <>
          <Text style={styles.section}>Lesson Connections</Text>
          {summary.interLessonConnections.map((c) => (
            <View key={c.id} style={styles.card}>
              <Text style={styles.cardTitle}>{c.connection}</Text>
              <Text style={styles.cardDesc}>{c.description}</Text>
            </View>
          ))}
        </>
      )}
    </>
  );
}

function TeacherSummaryView({ summary, transcript }: { summary: TeacherSummary; transcript?: string }) {

  return (
    <>
      <View style={styles.headerCard}>
        <Text style={styles.headerText}>
          Style: {summary.teachingStyle} · Interaction: {summary.interactionLevel}
        </Text>
      </View>

      <Text style={styles.section}>Teaching Structure</Text>
      {summary.teachingStructure.map((s, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.cardTitle}>{s.section}</Text>
          <Text style={styles.cardDesc}>{s.description}</Text>
          <Text style={styles.cardHint}>{s.durationHint}</Text>
        </View>
      ))}

      <Text style={styles.section}>Question Analysis</Text>
      {summary.questionTypes.map((q, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.cardTitle}>
            {q.type} (x{q.count})
          </Text>
          <Text style={styles.cardDesc}>{q.quality}</Text>
          {q.examples.map((e, j) => (
            <Text key={j} style={styles.example}>
              "{e}"
            </Text>
          ))}
        </View>
      ))}

      <StudentSummaryView summary={summary} />

      <Text style={styles.section}>Improvement Suggestions</Text>
      {summary.improvementSuggestions.map((s, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.cardDesc}>- {s}</Text>
        </View>
      ))}
    </>
  );
}

function MeetingSummaryView({ summary }: { summary: MeetingSummary }) {
  return (
    <>
      <Text style={styles.section}>Decisions</Text>
      {summary.decisions.length === 0 && (
        <Text style={styles.emptyText}>No decisions recorded</Text>
      )}
      {summary.decisions.map((d) => (
        <View key={d.id} style={styles.card}>
          <Text style={styles.cardTitle}>{d.content}</Text>
          <Text style={styles.cardDesc}>{d.context}</Text>
        </View>
      ))}

      <Text style={styles.section}>Action Items</Text>
      {summary.actionItems.length === 0 && (
        <Text style={styles.emptyText}>No action items recorded</Text>
      )}
      {summary.actionItems.map((a) => (
        <View key={a.id} style={styles.card}>
          <Text style={styles.cardTitle}>
            {a.content} {a.deadline ? `(by ${a.deadline})` : ""}
          </Text>
          <Text style={styles.cardDesc}>Assignee: {a.assignee}</Text>
        </View>
      ))}

      <Text style={styles.section}>Key Points</Text>
      {summary.keyPoints.length === 0 && (
        <Text style={styles.emptyText}>No key points recorded</Text>
      )}
      {summary.keyPoints.map((kp, i) => (
        <View key={i} style={styles.card}>
          <Text style={styles.cardDesc}>- {kp}</Text>
        </View>
      ))}
    </>
  );
}

export default function SummaryScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Route>();
  const { session: initialSession } = route.params;

  const [session, setSession] = useState(initialSession);
  const [streamingText, setStreamingText] = useState("");
  const [debugInfo, setDebugInfo] = useState<string[]>([]);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  const [debugExpanded, setDebugExpanded] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const doneReported = useRef(false);

  const addDebug = (msg: string) => {
    setDebugInfo(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  const isDone = session.phase === "done";
  const isFailed = session.phase === "failed";
  const processing = !isDone && !isFailed;
  const processingStage = session.phase as string;

  // Start processing and poll for updates
  useEffect(() => {
    if (isDone || isFailed) return;

    let mounted = true;
    doneReported.current = false;
    addDebug(`Queue: starting processing for ${initialSession.id}`);
    startProcessing(initialSession.id);

    // Poll session from DB every second while processing
    const poll = async () => {
      try {
        const updated = await getSessionById(initialSession.id);
        if (updated && mounted) {
          setSession(updated);
          // Poll for streaming text during summarization
          if (updated.phase === "summarizing") {
            const text = await getSessionPartialSummary(initialSession.id);
            if (text && mounted) setStreamingText(text);
          }
          if ((updated.phase === "done" || updated.phase === "failed") && !doneReported.current) {
            doneReported.current = true;
            addDebug(`Queue: ${updated.phase}`);
            if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          }
        }
      } catch {
        if (mounted) addDebug("Could not refresh processing status.");
      }
    };

    pollRef.current = setInterval(poll, 1000);

    // Listen for queue events (faster than polling)
    const unsub = addQueueListener(poll);

    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
      unsub();
    };
  }, [initialSession.id, processing]);

  const handleShare = async (format: "pdf" | "markdown") => {
    setExporting(true); setExportError("");
    try {
      await exportDocument(format, session.title || "session", format === "pdf" ? sessionToHtml(session) : sessionToMarkdown(session));
      setExportOpen(false);
    } catch (error: any) { setExportError(error.message ?? "Export failed."); }
    finally { setExporting(false); }
  };

  usePreventRemove(processing, ({ data }) => {
    const leave = () => navigation.dispatch(data.action);
    if (Platform.OS === "web") {
      if (window.confirm("Processing is still running. Leave this page and continue in the background?")) leave();
      return;
    }
    const { running, sessionId } = getQueueState();
    const isThisSession = running && sessionId === initialSession.id;

    Alert.alert(
      "Processing in progress",
      isThisSession
        ? "Transcription or analysis is still running. You can leave — processing will continue in the background."
        : "Processing is still running.",
      [
        { text: "Wait", style: "cancel" },
        {
          text: isThisSession ? "Leave (background)" : "Leave",
          style: isThisSession ? "default" : "destructive",
          onPress: leave,
        },
        ...(isThisSession
          ? [{
              text: "Abort & Leave",
              style: "destructive" as const,
              onPress: () => {
                abortProcessing().finally(leave);
              },
            }]
          : []),
      ],
    );
  });
  const handleDone = () => navigation.popToTop();

  const summary = session.summary;
  const speakerLabeled = (summary as any)?.speakerLabeledTranscript as string | undefined;
  const displayTranscript = speakerLabeled || session.transcript;
  const displayTitle =
    session.title ||
    (summary && session.mode.startsWith("classroom")
      ? (summary as StudentSummary).courseName
      : summary
        ? (summary as MeetingSummary).title
        : session.mode.startsWith("classroom")
          ? "课堂记录"
          : "会议记录");

  return (
    <PageEntrance style={uiStyles.page}>
      <ScreenHeader title="Summary" back onBack={handleDone} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{displayTitle}</Text>

        {session.createdAt && session.endTime && (
          <Text style={styles.timeRange}>
            {new Date(session.createdAt).toLocaleString()} —{" "}
            {new Date(session.endTime).toLocaleTimeString()}
          </Text>
        )}

        {processing && (
          <View style={styles.processing}>
            <Text style={styles.processingTitle}>Processing Recording</Text>

            {streamingText.length > 0 && (
              <View style={styles.streamingCard}>
                <Text style={styles.streamingTitle}>AI is generating summary...</Text>
                <Text style={styles.streamingText} numberOfLines={20}>
                  {streamingText}
                </Text>
              </View>
            )}

            <View style={styles.stagesContainer}>
              {/* Stage 1: STT */}
              <View style={styles.stageRow}>
                <View style={[
                  styles.stageIndicator,
                  processingStage === "transcribing" && styles.stageActive,
                  (processingStage === "summarizing" || processingStage === "indexing" || processingStage === "done") && styles.stageDone,
                ]}>
                  {processingStage === "transcribing" ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : processingStage === "summarizing" || processingStage === "indexing" || processingStage === "done" ? (
                    <Text style={styles.checkmark}>✓</Text>
                  ) : (
                    <Text style={styles.stageNum}>1</Text>
                  )}
                </View>
                <View style={styles.stageTextCol}>
                  <Text style={[
                    styles.stageTitle,
                    processingStage === "transcribing" && styles.stageTitleActive,
                  ]}>
                    Speech to Text
                  </Text>
                  <Text style={styles.stageHint}>
                    {processingStage === "transcribing"
                      ? "Converting audio to text via Whisper..."
                      : "Transcription complete"}
                  </Text>
                </View>
              </View>

              {/* Connector line */}
              <View style={[
                styles.connector,
                (processingStage === "summarizing" || processingStage === "indexing" || processingStage === "done") && styles.connectorDone,
              ]} />

              {/* Stage 2: LLM */}
              <View style={styles.stageRow}>
                <View style={[
                  styles.stageIndicator,
                  processingStage === "summarizing" && styles.stageActive,
                  (processingStage === "indexing" || processingStage === "done") && styles.stageDone,
                ]}>
                  {processingStage === "summarizing" ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : processingStage === "indexing" || processingStage === "done" ? (
                    <Text style={styles.checkmark}>✓</Text>
                  ) : (
                    <Text style={styles.stageNum}>2</Text>
                  )}
                </View>
                <View style={styles.stageTextCol}>
                  <Text style={[
                    styles.stageTitle,
                    processingStage === "summarizing" && styles.stageTitleActive,
                  ]}>
                    AI Summarization
                  </Text>
                  <Text style={styles.stageHint}>
                    {processingStage === "transcribing"
                      ? "Waiting for transcription..."
                      : processingStage === "summarizing"
                        ? "Analyzing with DeepSeek LLM..."
                        : "Summary complete"}
                  </Text>
                </View>
              </View>

              {/* Connector line */}
              <View style={[
                styles.connector,
                (processingStage === "indexing" || processingStage === "done") && styles.connectorDone,
              ]} />

              {/* Stage 3: Vector Indexing */}
              <View style={styles.stageRow}>
                <View style={[
                  styles.stageIndicator,
                  processingStage === "indexing" && styles.stageActive,
                  (processingStage === "extracting" || processingStage === "done") && styles.stageDone,
                ]}>
                  {processingStage === "indexing" ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : processingStage === "extracting" || processingStage === "done" ? (
                    <Text style={styles.checkmark}>✓</Text>
                  ) : (
                    <Text style={styles.stageNum}>3</Text>
                  )}
                </View>
                <View style={styles.stageTextCol}>
                  <Text style={[
                    styles.stageTitle,
                    processingStage === "indexing" && styles.stageTitleActive,
                  ]}>
                    Vector Indexing
                  </Text>
                  <Text style={styles.stageHint}>
                    {processingStage === "transcribing" || processingStage === "summarizing"
                      ? "Waiting for summary..."
                      : processingStage === "indexing"
                        ? "Generating embeddings for RAG knowledge base..."
                        : processingStage === "done" && session.embeddingMethod
                          ? `Indexed with ${session.embeddingMethod}`
                          : "Indexing complete"}
                  </Text>
                </View>
              </View>

              {/* Connector line */}
              <View style={[
                styles.connector,
                (processingStage === "done") && styles.connectorDone,
              ]} />

              {/* Stage 4: Skill Extraction */}
              <View style={styles.stageRow}>
                <View style={[
                  styles.stageIndicator,
                  processingStage === "extracting" && styles.stageActive,
                  processingStage === "done" && styles.stageDone,
                ]}>
                  {processingStage === "extracting" ? (
                    <ActivityIndicator size="small" color="#FFFFFF" />
                  ) : processingStage === "done" ? (
                    <Text style={styles.checkmark}>✓</Text>
                  ) : (
                    <Text style={styles.stageNum}>4</Text>
                  )}
                </View>
                <View style={styles.stageTextCol}>
                  <Text style={[
                    styles.stageTitle,
                    processingStage === "extracting" && styles.stageTitleActive,
                  ]}>
                    Skill Extraction
                  </Text>
                  <Text style={styles.stageHint}>
                    {processingStage === "transcribing" || processingStage === "summarizing" || processingStage === "indexing"
                      ? "Waiting for indexing..."
                      : processingStage === "extracting"
                        ? "Extracting reusable skills from transcript..."
                        : "Skills extracted"}
                  </Text>
                </View>
              </View>
            </View>
          </View>
        )}

        {isFailed && (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Processing Error</Text>
            <Text style={styles.errorText}>{session.error || "Unknown error"}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              accessibilityRole="button"
              accessibilityLabel="Retry Processing"
              onPress={async () => {
                try {
                  await updateSessionPhase(session.id, "queued");
                  setSession(s => ({ ...s, phase: "queued", error: undefined }));
                } catch {
                  setSession(s => ({ ...s, error: "Could not retry recording." }));
                }
              }}
            >
              <RotateCcw size={18} color={colors.surface} />
              <Text style={styles.retryButtonText}>Retry Processing</Text>
            </TouchableOpacity>
          </View>
        )}

        {!processing && !isFailed && !session.transcript && (
          <View style={styles.warningCard}>
            <Text style={styles.warningTitle}>No transcript captured</Text>
            <Text style={styles.warningText}>
              Whisper transcription may have failed. Check that the audio file
              exists and try again. The recording was saved but no text was
              extracted.
            </Text>
          </View>
        )}

        {summary && session.mode === "classroom-student" && (
          <StudentSummaryView summary={summary as StudentSummary} />
        )}
        {summary && session.mode === "classroom-teacher" && (
          <TeacherSummaryView summary={summary as TeacherSummary} transcript={speakerLabeled} />
        )}
        {summary && session.mode.startsWith("meeting") && (
          <MeetingSummaryView summary={summary as MeetingSummary} />
        )}
        {displayTranscript && (
          <View style={styles.details}>
            <TouchableOpacity style={styles.detailsToggle} accessibilityRole="button" accessibilityLabel="Transcript"
              accessibilityState={{ expanded: transcriptExpanded }} onPress={() => setTranscriptExpanded(value => !value)}>
              <Text style={styles.detailsTitle}>{speakerLabeled ? "Speaker-Labeled Transcript" : "Transcript"}</Text>
              {transcriptExpanded ? <ChevronDown size={18} color={colors.muted} /> : <ChevronRight size={18} color={colors.muted} />}
            </TouchableOpacity>
            {transcriptExpanded && <Text selectable style={styles.transcriptText}>{displayTranscript}</Text>}
          </View>
        )}
        {debugInfo.length > 0 && (
          <View style={styles.details}>
            <TouchableOpacity style={styles.detailsToggle} accessibilityRole="button" accessibilityState={{ expanded: debugExpanded }}
              onPress={() => setDebugExpanded(value => !value)}>
              <Text style={styles.detailsTitle}>Processing log</Text>
              {debugExpanded ? <ChevronDown size={18} color={colors.muted} /> : <ChevronRight size={18} color={colors.muted} />}
            </TouchableOpacity>
            {debugExpanded && debugInfo.map((line, index) => <Text key={index} style={styles.debugText}>{line}</Text>)}
          </View>
        )}
      </ScrollView>

      {!!exportError && <Text accessibilityRole="alert" style={styles.exportError}>{exportError}</Text>}
      {exportOpen && <View style={styles.exportOptions}>
        {(["pdf", "markdown"] as const).map(format => <TouchableOpacity key={format} accessibilityRole="button" disabled={exporting}
          onPress={() => void handleShare(format)} style={styles.exportOption}>
          <FileText size={18} color={colors.accent} /><Text style={styles.detailsTitle}>{format === "pdf" ? "PDF" : "Markdown"}</Text>
        </TouchableOpacity>)}
      </View>}
      <View style={styles.actions}>
        <IconButton icon={Download} label="Export recording" disabled={exporting} onPress={() => setExportOpen(value => !value)} />
        <TouchableOpacity
          style={styles.doneButton}
          accessibilityRole="button"
          onPress={handleDone}
        >
          <Check size={18} color={colors.surface} />
          <Text style={styles.doneButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </PageEntrance>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, paddingTop: 4, paddingBottom: 32 },
  title: { fontSize: 28, fontFamily: fonts.reading, color: colors.text, marginBottom: 12 },
  timeRange: {
    fontSize: 12, fontFamily: fonts.body,
    color: colors.muted,
    marginBottom: 24,
  },
  section: {
    fontSize: 18,
    fontFamily: fonts.strong,
    color: colors.text,
    marginTop: 24,
    marginBottom: 12,
  },
  card: {
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
    paddingVertical: 14,
    marginBottom: 4,
  },
  cardTitle: { fontSize: 15, fontFamily: fonts.strong, color: colors.text },
  cardDesc: { fontSize: 14, fontFamily: fonts.body, color: colors.text, marginTop: 6, lineHeight: 23 },
  cardHint: { fontSize: 12, fontFamily: fonts.body, color: colors.accent, marginTop: 8 },
  emptyText: { fontSize: 13, fontFamily: fonts.body, color: colors.muted, marginBottom: 8 },
  warningCard: {
    borderLeftWidth: 2, borderLeftColor: colors.amber,
    paddingLeft: 14, paddingVertical: 8,
    marginBottom: 16,
  },
  warningTitle: { fontSize: 14, fontFamily: fonts.strong, color: colors.amber },
  warningText: { fontSize: 13, fontFamily: fonts.body, color: colors.muted, marginTop: 4, lineHeight: 21 },
  example: { fontSize: 13, fontFamily: fonts.reading, color: colors.muted, marginTop: 6 },
  headerCard: {
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line,
    marginBottom: 8,
  },
  headerText: { fontSize: 14, color: colors.accent, fontFamily: fonts.body },
  processing: { marginTop: 20 },
  processingTitle: { fontSize: 18, fontFamily: fonts.strong, color: colors.text, marginBottom: 24 },
  stagesContainer: { width: "100%", paddingHorizontal: 8 },
  stageRow: { flexDirection: "row", alignItems: "center", gap: 14 },
  stageIndicator: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "#E8EAED",
    justifyContent: "center",
    alignItems: "center",
  },
  stageActive: { backgroundColor: colors.accent },
  stageDone: { backgroundColor: colors.accent },
  stageNum: { fontSize: 14, fontFamily: fonts.strong, color: colors.muted },
  checkmark: { fontSize: 16, fontWeight: "700", color: "#FFFFFF" },
  stageTextCol: { flex: 1 },
  stageTitle: { fontSize: 15, fontFamily: fonts.strong, color: colors.muted },
  stageTitleActive: { color: colors.text },
  stageHint: { fontSize: 12, fontFamily: fonts.body, color: colors.muted, marginTop: 4 },
  connector: {
    width: 2,
    height: 20,
    backgroundColor: "#E8EAED",
    marginLeft: 15,
    marginVertical: 4,
  },
  connectorDone: { backgroundColor: colors.accent },
  errorCard: {
    borderLeftWidth: 2, borderLeftColor: colors.red,
    paddingLeft: 14, paddingVertical: 8,
    marginTop: 16,
  },
  errorTitle: { fontSize: 15, fontFamily: fonts.strong, color: colors.red },
  errorText: { fontSize: 13, fontFamily: fonts.body, color: colors.red, marginTop: 4 },
  retryButton: {
    marginTop: 16,
    backgroundColor: colors.accent,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8,
  },
  retryButtonText: { color: colors.surface, fontSize: 14, fontFamily: fonts.strong },
  transcriptCard: {
    backgroundColor: "#F8F9FA",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  transcriptText: {
    fontSize: 14, fontFamily: fonts.body,
    color: colors.text,
    lineHeight: 24,
  },
  actions: {
    flexDirection: "row",
    padding: 16,
    gap: 12,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  shareButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#1A73E8",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  shareButtonText: { color: "#1A73E8", fontSize: 16, fontWeight: "500" },
  doneButton: {
    marginLeft: "auto", paddingHorizontal: 24,
    backgroundColor: colors.accent,
    borderRadius: 8, minHeight: 44,
    flexDirection: "row", justifyContent: "center", gap: 8,
    alignItems: "center",
  },
  doneButtonText: { color: colors.surface, fontSize: 14, fontFamily: fonts.strong },
  details: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 24 },
  detailsToggle: { flexDirection: "row", gap: 12, alignItems: "center", minHeight: 52 },
  detailsTitle: { flex: 1, fontSize: 14, fontFamily: fonts.strong, color: colors.muted },
  exportOptions: { flexDirection: "row", gap: 12, paddingHorizontal: 24, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.line },
  exportOption: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", gap: 8 },
  exportError: { fontSize: 13, fontFamily: fonts.body, color: colors.red, paddingHorizontal: 24, paddingVertical: 8 },
  debugCard: {
    backgroundColor: "#E8F0FE",
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
  },
  debugTitle: { fontSize: 14, fontWeight: "600", color: "#1A73E8", marginBottom: 8 },
  debugText: { fontSize: 11, color: "#3C4043", fontFamily: "monospace", lineHeight: 16 },
  streamingCard: {
    backgroundColor: "#F8F9FA",
    borderRadius: 10,
    padding: 14,
    marginBottom: 24,
    width: "100%",
  },
  streamingTitle: { fontSize: 13, fontFamily: fonts.strong, color: colors.accent, marginBottom: 8 },
  streamingText: { fontSize: 13, fontFamily: fonts.body, color: colors.text, lineHeight: 22 },
  engagementCard: {
    backgroundColor: "#F0F4F8",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  engagementTitle: { fontSize: 13, fontWeight: "600", color: "#5F6368", marginBottom: 8 },
  engagementGrid: { flexDirection: "row", justifyContent: "space-between" },
  engagementStat: { alignItems: "center" },
  engagementValue: { fontSize: 20, fontWeight: "700", color: "#1A73E8" },
  engagementLabel: { fontSize: 11, color: "#5F6368", marginTop: 2 },
});
