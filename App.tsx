import { useEffect } from "react";
import { ActivityIndicator, AppState, Platform, View } from "react-native";
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
import { seedDefaultApiKey } from "./src/services/api";
import { seedDefaultSiliconFlowKey } from "./src/services/embedding";
import { recoverInterruptedSessions } from "./src/services/recovery";
import { resumeStuckTasks } from "./src/services/processingQueue";
import { markAppStart, markAppReady } from "./src/services/perf";
import { autoUpdateDailyDiary, handleDiaryForeground, initDiaryService } from "./src/services/diary";

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

      // Seed default API keys on first launch only
      await Promise.all([
        seedDefaultApiKey(),
        seedDefaultSiliconFlowKey(),
      ]);

      // Recover interrupted work from previous session
      await recoverInterruptedSessions();

      // Resume any stuck processing tasks (STT/LLM)
      resumeStuckTasks().catch(() => {});

      // Attempt to drain any pending offline jobs
      drainQueue().catch(() => {});

      // Diary import/processing is consent-gated and foreground best-effort.
      handleDiaryForeground().catch(() => {});
      autoUpdateDailyDiary().catch(() => {});

      markAppReady();
    }

    init().catch(console.error);

    const appStateSub = AppState.addEventListener("change", state => {
      if (state === "active") {
        handleDiaryForeground().catch(() => {});
        autoUpdateDailyDiary().catch(() => {});
      }
    });

    // 前台每分钟做一次日记维护：定期处理新片段，并在跨天后自动生成前一天日记
    const maintenanceId = setInterval(() => {
      if (AppState.currentState !== "active") return;
      handleDiaryForeground().catch(() => {});
      autoUpdateDailyDiary().catch(() => {});
    }, 60_000);

    return () => {
      appStateSub.remove();
      clearInterval(maintenanceId);
    };
  }, []);

  // 采集期间原生前台服务每 60 秒发一次事件，驱动转写队列，避免等停止采集后才批量处理
  useEffect(() => {
    if (Platform.OS !== "android") return;
    let cancelled = false;
    let cleanup: (() => void) | null = null;
    (async () => {
      try {
        const { PcmRecorder } = await import("./modules/pcm-recorder/src");
        if (cancelled) return;
        // 片段结束事件可能很密集，用 5 秒时间窗节流（不依赖 setTimeout，后台也能触发）
        let lastTriggeredAt = 0;
        const scheduleProcessing = () => {
          const now = Date.now();
          if (now - lastTriggeredAt < 5000) return;
          lastTriggeredAt = now;
          handleDiaryForeground().catch(() => {});
        };
        const onTick = PcmRecorder.addListener("onDiaryTick", () => {
          console.error("[DiaryTick] received");
          scheduleProcessing();
        });
        const onSegment = PcmRecorder.addListener("onDiarySegment", scheduleProcessing);
        cleanup = () => {
          onTick.remove();
          onSegment.remove();
        };
      } catch {
        // 原生事件不可用时仍然依赖前台定时器处理
      }
    })();
    return () => {
      cancelled = true;
      cleanup?.();
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
