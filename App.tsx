import { useEffect } from "react";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AppNavigator from "./src/navigation/AppNavigator";
import RecordingScreen from "./src/screens/RecordingScreen";
import SummaryScreen from "./src/screens/SummaryScreen";
import type { SessionMode, Session } from "./src/types";
import { initSkillsTable } from "./src/services/skills";
import { initEmbeddingsTable } from "./src/services/vectorStore";
import { initQueueTable, drainQueue } from "./src/services/offlineQueue";
import { recoverInterruptedSessions } from "./src/services/recovery";
import { resumeStuckTasks } from "./src/services/processingQueue";
import { markAppStart, markAppReady } from "./src/services/perf";

export type RootStackParamList = {
  Main: undefined;
  Recording: { mode: SessionMode };
  Summary: { session: Session };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  useEffect(() => {
    markAppStart();

    async function init() {
      // Initialize all DB tables
      await Promise.all([
        initSkillsTable(),
        initEmbeddingsTable(),
        initQueueTable(),
      ]);

      // Recover interrupted work from previous session
      await recoverInterruptedSessions();

      // Resume any stuck processing tasks (STT/LLM)
      resumeStuckTasks().catch(() => {});

      // Attempt to drain any pending offline jobs
      drainQueue().catch(() => {});

      markAppReady();
    }

    init().catch(console.error);
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="auto" />
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Main" component={AppNavigator} />
          <Stack.Screen
            name="Recording"
            component={RecordingScreen}
            options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
          />
          <Stack.Screen
            name="Summary"
            component={SummaryScreen}
            options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
