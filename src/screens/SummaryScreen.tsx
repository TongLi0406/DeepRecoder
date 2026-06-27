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
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { StudentSummary, TeacherSummary, MeetingSummary } from "../types";
import { getSessionById, getSessionPartialSummary, updateSessionPhase } from "../services/storage";
import { startProcessing, abortProcessing, getQueueState, addQueueListener } from "../services/processingQueue";
import { sessionToHtml, sessionToMarkdown } from "../services/export";
import { analyzeEngagement } from "../services/engagement";

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
  const analytics = transcript ? analyzeEngagement(transcript) : null;

  return (
    <>
      <View style={styles.headerCard}>
        <Text style={styles.headerText}>
          Style: {summary.teachingStyle} · Interaction: {summary.interactionLevel}
        </Text>
      </View>

      {analytics && (
        <View style={styles.engagementCard}>
          <Text style={styles.engagementTitle}>Engagement Metrics</Text>
          <View style={styles.engagementGrid}>
            <View style={styles.engagementStat}>
              <Text style={styles.engagementValue}>{analytics.speakerCount}</Text>
              <Text style={styles.engagementLabel}>Speakers</Text>
            </View>
            <View style={styles.engagementStat}>
              <Text style={styles.engagementValue}>{analytics.questionCount}</Text>
              <Text style={styles.engagementLabel}>Questions</Text>
            </View>
            <View style={styles.engagementStat}>
              <Text style={styles.engagementValue}>{Math.round(analytics.participationRatio * 100)}%</Text>
              <Text style={styles.engagementLabel}>Student Talk</Text>
            </View>
            <View style={styles.engagementStat}>
              <Text style={styles.engagementValue}>{analytics.teacherUtterances + analytics.studentUtterances}</Text>
              <Text style={styles.engagementLabel}>Utterances</Text>
            </View>
          </View>
        </View>
      )}

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

    addDebug(`Queue: starting processing for ${initialSession.id}`);
    startProcessing(initialSession.id);

    // Poll session from DB every second while processing
    const poll = async () => {
      const updated = await getSessionById(initialSession.id);
      if (updated) {
        setSession(updated);
        // Poll for streaming text during summarization
        if (updated.phase === "summarizing") {
          const text = await getSessionPartialSummary(initialSession.id);
          if (text) setStreamingText(text);
        }
        if ((updated.phase === "done" || updated.phase === "failed") && !doneReported.current) {
          doneReported.current = true;
          addDebug(`Queue: ${updated.phase}`);
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        }
      }
    };

    pollRef.current = setInterval(poll, 1000);

    // Listen for queue events (faster than polling)
    const unsub = addQueueListener(async () => {
      const updated = await getSessionById(initialSession.id);
      if (updated) setSession(updated);
    });

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      unsub();
    };
  }, [initialSession.id]);

  const handleShare = async () => {
    Alert.alert("Export", "Choose export format:", [
      {
        text: "PDF",
        onPress: async () => {
          try {
            const { printToFileAsync } = await import("expo-print");
            const { shareAsync } = await import("expo-sharing");
            const html = sessionToHtml(session);
            const file = await printToFileAsync({ html, base64: false });
            await shareAsync(file.uri, { mimeType: "application/pdf" });
          } catch (e: any) {
            Alert.alert("Export failed", e.message);
          }
        },
      },
      {
        text: "Markdown",
        onPress: async () => {
          try {
            const { writeAsStringAsync, documentDirectory } = await import("expo-file-system/legacy");
            const { shareAsync } = await import("expo-sharing");
            const md = sessionToMarkdown(session);
            const name = (session.title || "session").replace(/[^a-zA-Z0-9一-鿿]/g, "_");
            const fileUri = `${documentDirectory}${name}.md`;
            await writeAsStringAsync(fileUri, md, { encoding: "utf8" });
            await shareAsync(fileUri, { mimeType: "text/markdown" });
          } catch (e: any) {
            Alert.alert("Export failed", e.message);
          }
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const handleDone = () => {
    if (processing) {
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
            onPress: () => navigation.popToTop(),
          },
          ...(isThisSession
            ? [{
                text: "Abort & Leave",
                style: "destructive" as const,
                onPress: () => {
                  abortProcessing().finally(() => navigation.popToTop());
                },
              }]
            : []),
        ],
      );
    } else {
      navigation.popToTop();
    }
  };

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
    <View style={styles.container}>
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
              onPress={() => {
                setSession((s) => s ? { ...s, phase: "queued", error: undefined } : s);
                updateSessionPhase(session.id, "queued").catch(() => {});
                startProcessing(session.id);
              }}
            >
              <Text style={styles.retryButtonText}>Retry Processing</Text>
            </TouchableOpacity>
            {session.transcript && (
              <>
                <Text style={styles.section}>Raw Transcript</Text>
                <View style={styles.card}>
                  <Text style={styles.transcriptText}>
                    {session.transcript}
                  </Text>
                </View>
              </>
            )}
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

        {debugInfo.length > 0 && (
          <View style={styles.debugCard}>
            <Text style={styles.debugTitle}>Debug Info</Text>
            {debugInfo.map((line, i) => (
              <Text key={i} style={styles.debugText}>{line}</Text>
            ))}
          </View>
        )}

        {displayTranscript && !summary && (
          <>
            <Text style={styles.section}>Transcript</Text>
            <View style={styles.transcriptCard}>
              <Text style={styles.transcriptText}>
                {displayTranscript}
              </Text>
            </View>
          </>
        )}

        {displayTranscript && summary && (
          <>
            <Text style={styles.section}>
              {speakerLabeled ? "Speaker-Labeled Transcript" : "Transcript"}
            </Text>
            <View style={styles.transcriptCard}>
              <Text style={styles.transcriptText}>
                {displayTranscript}
              </Text>
            </View>
          </>
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
      </ScrollView>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.shareButton} onPress={handleShare}>
          <Text style={styles.shareButtonText}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.doneButton}
          onPress={handleDone}
        >
          <Text style={styles.doneButtonText}>Done</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#FFFFFF" },
  content: { padding: 24, paddingTop: 60, paddingBottom: 100 },
  title: { fontSize: 24, fontWeight: "700", color: "#1A1A1A", marginBottom: 4 },
  timeRange: {
    fontSize: 13,
    color: "#5F6368",
    marginBottom: 24,
  },
  section: {
    fontSize: 18,
    fontWeight: "600",
    color: "#1A1A1A",
    marginTop: 24,
    marginBottom: 12,
  },
  card: {
    backgroundColor: "#F8F9FA",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  cardTitle: { fontSize: 15, fontWeight: "600", color: "#1A1A1A" },
  cardDesc: { fontSize: 13, color: "#5F6368", marginTop: 4, lineHeight: 18 },
  cardHint: { fontSize: 12, color: "#1A73E8", marginTop: 6, fontStyle: "italic" },
  emptyText: { fontSize: 13, color: "#9AA0A6", marginBottom: 8, fontStyle: "italic" },
  warningCard: {
    backgroundColor: "#FEF7E0",
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
  },
  warningTitle: { fontSize: 14, fontWeight: "600", color: "#E37400" },
  warningText: { fontSize: 13, color: "#5F6368", marginTop: 4, lineHeight: 18 },
  example: { fontSize: 12, color: "#9AA0A6", marginTop: 2, fontStyle: "italic" },
  headerCard: {
    backgroundColor: "#E8F0FE",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  headerText: { fontSize: 15, color: "#1A73E8", fontWeight: "500" },
  processing: { alignItems: "center", marginTop: 60 },
  processingTitle: { fontSize: 18, fontWeight: "600", color: "#1A1A1A", marginBottom: 32 },
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
  stageActive: { backgroundColor: "#1A73E8" },
  stageDone: { backgroundColor: "#34A853" },
  stageNum: { fontSize: 14, fontWeight: "600", color: "#5F6368" },
  checkmark: { fontSize: 16, fontWeight: "700", color: "#FFFFFF" },
  stageTextCol: { flex: 1 },
  stageTitle: { fontSize: 15, fontWeight: "500", color: "#5F6368" },
  stageTitleActive: { color: "#1A1A1A", fontWeight: "600" },
  stageHint: { fontSize: 12, color: "#9AA0A6", marginTop: 2 },
  connector: {
    width: 2,
    height: 20,
    backgroundColor: "#E8EAED",
    marginLeft: 15,
    marginVertical: 4,
  },
  connectorDone: { backgroundColor: "#34A853" },
  errorCard: {
    backgroundColor: "#FCE8E6",
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
  },
  errorTitle: { fontSize: 15, fontWeight: "600", color: "#C5221F" },
  errorText: { fontSize: 13, color: "#C5221F", marginTop: 4 },
  retryButton: {
    marginTop: 16,
    backgroundColor: "#1A73E8",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  retryButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  transcriptCard: {
    backgroundColor: "#F8F9FA",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  transcriptText: {
    fontSize: 13,
    color: "#3C4043",
    lineHeight: 20,
  },
  actions: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    padding: 16,
    paddingBottom: 32,
    gap: 12,
    backgroundColor: "#FFFFFF",
    borderTopWidth: 1,
    borderTopColor: "#E8EAED",
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
    flex: 1,
    backgroundColor: "#1A73E8",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  doneButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
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
  streamingTitle: { fontSize: 13, fontWeight: "600", color: "#1A73E8", marginBottom: 8 },
  streamingText: { fontSize: 12, color: "#3C4043", lineHeight: 18 },
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
