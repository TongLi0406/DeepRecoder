import { useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../../App";
import type { StudentSummary, TeacherSummary, MeetingSummary } from "../types";
import { summarize } from "../services/summarization";
import { updateSessionSummary } from "../services/storage";

type Nav = NativeStackNavigationProp<RootStackParamList, "Summary">;
type Route = RouteProp<RootStackParamList, "Summary">;

function StudentSummaryView({ summary }: { summary: StudentSummary }) {
  return (
    <>
      <Text style={styles.section}>Knowledge Points</Text>
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

function TeacherSummaryView({ summary }: { summary: TeacherSummary }) {
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
      {summary.decisions.map((d) => (
        <View key={d.id} style={styles.card}>
          <Text style={styles.cardTitle}>{d.content}</Text>
          <Text style={styles.cardDesc}>{d.context}</Text>
        </View>
      ))}

      <Text style={styles.section}>Action Items</Text>
      {summary.actionItems.map((a) => (
        <View key={a.id} style={styles.card}>
          <Text style={styles.cardTitle}>
            {a.content} {a.deadline ? `(by ${a.deadline})` : ""}
          </Text>
          <Text style={styles.cardDesc}>Assignee: {a.assignee}</Text>
        </View>
      ))}

      <Text style={styles.section}>Key Points</Text>
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
  const [processing, setProcessing] = useState(!initialSession.summary);
  const [error, setError] = useState<string | null>(null);
  const [speakerTranscript, setSpeakerTranscript] = useState<string | null>(null);

  useEffect(() => {
    if (initialSession.summary) return;

    let cancelled = false;
    async function process() {
      try {
        setProcessing(true);
        const transcript = initialSession.transcript || "";

        const result = await summarize(
          transcript,
          initialSession.mode,
          initialSession.createdAt,
          initialSession.endTime || new Date().toISOString(),
        );

        if (cancelled) return;

        const updatedSession = {
          ...initialSession,
          title: result.title,
          courseName: result.courseName,
          transcript: result.speakerLabeledTranscript || transcript,
          summary: result.summary,
          phase: "done" as const,
        };

        setSpeakerTranscript(result.speakerLabeledTranscript);
        setSession(updatedSession);
        setProcessing(false);

        await updateSessionSummary(
          updatedSession.id,
          updatedSession.summary,
          updatedSession.courseName,
          updatedSession.title,
          updatedSession.endTime,
        );
      } catch (e: any) {
        if (cancelled) return;
        setError(e.message || "Summarization failed");
        setProcessing(false);
      }
    }
    process();
    return () => { cancelled = true; };
  }, [initialSession.id]);

  const summary = session.summary;
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
            <ActivityIndicator size="large" color="#1A73E8" />
            <Text style={styles.processingText}>Processing...</Text>
            <Text style={styles.processingHint}>
              Transcribing and analyzing your recording
            </Text>
          </View>
        )}

        {error && (
          <View style={styles.errorCard}>
            <Text style={styles.errorTitle}>Processing Error</Text>
            <Text style={styles.errorText}>{error}</Text>
            {initialSession.transcript && (
              <>
                <Text style={styles.section}>Raw Transcript</Text>
                <View style={styles.card}>
                  <Text style={styles.transcriptText}>
                    {initialSession.transcript}
                  </Text>
                </View>
              </>
            )}
          </View>
        )}

        {speakerTranscript && (
          <>
            <Text style={styles.section}>Transcript</Text>
            <View style={styles.transcriptCard}>
              <Text style={styles.transcriptText}>
                {speakerTranscript}
              </Text>
            </View>
          </>
        )}

        {summary && session.mode === "classroom-student" && (
          <StudentSummaryView summary={summary as StudentSummary} />
        )}
        {summary && session.mode === "classroom-teacher" && (
          <TeacherSummaryView summary={summary as TeacherSummary} />
        )}
        {summary && session.mode.startsWith("meeting") && (
          <MeetingSummaryView summary={summary as MeetingSummary} />
        )}
      </ScrollView>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.shareButton}>
          <Text style={styles.shareButtonText}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.doneButton}
          onPress={() => navigation.popToTop()}
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
  example: { fontSize: 12, color: "#9AA0A6", marginTop: 2, fontStyle: "italic" },
  headerCard: {
    backgroundColor: "#E8F0FE",
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  headerText: { fontSize: 15, color: "#1A73E8", fontWeight: "500" },
  processing: { alignItems: "center", marginTop: 80 },
  processingText: { fontSize: 18, fontWeight: "600", color: "#1A1A1A", marginTop: 16 },
  processingHint: { fontSize: 13, color: "#5F6368", marginTop: 8 },
  errorCard: {
    backgroundColor: "#FCE8E6",
    borderRadius: 10,
    padding: 14,
    marginTop: 16,
  },
  errorTitle: { fontSize: 15, fontWeight: "600", color: "#C5221F" },
  errorText: { fontSize: 13, color: "#C5221F", marginTop: 4 },
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
});
