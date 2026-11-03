import { useEffect } from "react";
import { ActivityIndicator, AppState, View } from "react-native";
import { useFonts } from "expo-font";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import AppNavigator from "./src/navigation/AppNavigator";
import RecordingScreen from "./src/screens/RecordingScreen";
import SummaryScreen from "./src/screens/SummaryScreen";
import SettingsScreen from "./src/screens/SettingsScreen";
import { DiarySettingsScreen } from "./src/screens/DiaryScreen";
import { colors, useReducedMotion } from "./src/ui";
import type { SessionMode, Session } from "./src/types";
import { initSkillsTable } from "./src/services/skills";
import { initEmbeddingsTable } from "./src/services/vectorStore";
import { initQueueTable, drainQueue } from "./src/services/offlineQueue";
import { recoverInterruptedSessions } from "./src/services/recovery";
import { resumeStuckTasks } from "./src/services/processingQueue";
import { markAppStart, markAppReady } from "./src/services/perf";
import { handleDiaryForeground, initDiaryService } from "./src/services/diary";

export type RootStackParamList = {
  Main: undefined;
  Recording: { mode: SessionMode; autoStart?: boolean };
  Summary: { session: Session };
  Settings: undefined;
  DiarySettings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  const reduced = useReducedMotion();
  const [fontsLoaded, fontError] = useFonts({
    Manrope: require("@expo-google-fonts/manrope/400Regular/Manrope_400Regular.ttf"),
    ManropeSemiBold: require("@expo-google-fonts/manrope/600SemiBold/Manrope_600SemiBold.ttf"),
    Newsreader: require("@expo-google-fonts/newsreader/400Regular/Newsreader_400Regular.ttf"),
  });
  useEffect(() => {
    markAppStart();

    async function init() {
      // Initialize all DB tables
      await Promise.all([
        initSkillsTable(),
        initEmbeddingsTable(),
        initQueueTable(),
        initDiaryService(),
      ]);

      // Recover interrupted work from previous session
      await recoverInterruptedSessions();

      // Resume any stuck processing tasks (STT/LLM)
      resumeStuckTasks().catch(() => {});

      // Attempt to drain any pending offline jobs
      drainQueue().catch(() => {});

      // Diary import/processing is consent-gated and foreground best-effort.
      handleDiaryForeground().catch(() => {});

      markAppReady();
    }

    init().catch(console.error);

    const appStateSub = AppState.addEventListener("change", state => {
      if (state === "active") {
        handleDiaryForeground().catch(() => {});
      }
    });

    return () => {
      appStateSub.remove();
    };
  }, []);

  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, justifyContent: "center", backgroundColor: colors.background }}><ActivityIndicator color={colors.accent} /></View>;
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <StatusBar style="auto" />
        <Stack.Navigator screenOptions={{ headerShown: false, animation: reduced ? "none" : "fade", contentStyle: { backgroundColor: colors.background } }}>
          <Stack.Screen name="Main" component={AppNavigator} />
          <Stack.Screen name="Settings" component={SettingsScreen} />
          <Stack.Screen name="DiarySettings" component={DiarySettingsScreen} />
          <Stack.Screen
            name="Recording"
            component={RecordingScreen}
            options={{ presentation: "fullScreenModal", animation: reduced ? "none" : "slide_from_bottom" }}
          />
          <Stack.Screen
            name="Summary"
            component={SummaryScreen}
            options={{ presentation: "fullScreenModal", animation: reduced ? "none" : "slide_from_bottom" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
