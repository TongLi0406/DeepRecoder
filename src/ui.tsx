import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Animated, AppState, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, Settings, type LucideIcon } from "lucide-react-native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParamList } from "../App";

export const colors = {
  background: "#FAFCFB", surface: "#FFFFFF", text: "#26312D", muted: "#69756F",
  line: "#E1E8E3", accent: "#276654", soft: "#EDF4F0", red: "#C44940", amber: "#996322",
};
export const fonts = { body: "Manrope", strong: "ManropeSemiBold", reading: "Newsreader" };

export function useReducedMotion() {
  const [reduced, setReduced] = useState(true);
  useEffect(() => {
    if (Platform.OS === "web") {
      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReduced(media.matches);
      update();
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (mounted) setReduced(value); }).catch(() => {});
    const listener = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { mounted = false; listener.remove(); };
  }, []);
  return reduced;
}

function useMotionAllowed() {
  const reduced = useReducedMotion();
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const focused = useIsFocused();
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => setForeground(state === "active"));
    return () => listener.remove();
  }, []);
  return !reduced && foreground && focused;
}

export function PageEntrance({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const allowed = useMotionAllowed();
  const progress = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!allowed) { progress.setValue(1); return; }
    progress.setValue(0);
    const animation = Animated.timing(progress, { toValue: 1, duration: 260, useNativeDriver: Platform.OS !== "web" });
    animation.start();
    return () => animation.stop();
  }, [allowed, progress]);
  return <Animated.View style={[style, {
    opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
    transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
  }]}>{children}</Animated.View>;
}

export function RecordingPulse({ active }: { active: boolean }) {
  const allowed = useMotionAllowed();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active || !allowed) { progress.setValue(0); return; }
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(progress, { toValue: 1, duration: 1500, useNativeDriver: Platform.OS !== "web" }),
      Animated.timing(progress, { toValue: 0, duration: 1500, useNativeDriver: Platform.OS !== "web" }),
    ]));
    animation.start();
    return () => animation.stop();
  }, [active, allowed, progress]);
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={[uiStyles.recordingRing, {
      borderColor: active ? colors.red : colors.line,
      opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.85] }),
      transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1.05] }) }],
    }]} />;
}

export function IconButton({ label, icon: Icon, onPress, disabled = false }: {
  label: string; icon: LucideIcon; onPress: () => void; disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [tooltipLeft, setTooltipLeft] = useState(0);
  const [tooltipAbove, setTooltipAbove] = useState(false);
  const buttonRef = useRef<View>(null);
  const { width, height } = useWindowDimensions();
  const showTooltip = () => {
    buttonRef.current?.measureInWindow((horizontal, vertical) => {
      setTooltipLeft(Math.max(8 - horizontal, Math.min(-58, width - horizontal - 168)));
      setTooltipAbove(vertical + 126 > height);
    });
    setHovered(true);
  };
  return (
    <Pressable ref={buttonRef} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
      onHoverIn={showTooltip} onHoverOut={() => setHovered(false)}
      onFocus={showTooltip} onBlur={() => setHovered(false)}
      style={({ pressed }) => [uiStyles.iconButton, (hovered || pressed) && { backgroundColor: colors.soft, zIndex: 20 }, disabled && { opacity: 0.4 }]}
    >
      <Icon size={21} strokeWidth={1.7} color={colors.text} />
      {hovered && !disabled && <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={[uiStyles.tooltip, { left: tooltipLeft, ...(tooltipAbove ? { bottom: 48 } : { top: 48 }) }]}>
        <Text numberOfLines={3} style={uiStyles.tooltipText}>{label}</Text>
      </View>}
    </Pressable>
  );
}

export function ScreenHeader({ title, back = false, caption, onBack }: { title: string; back?: boolean; caption?: string; onBack?: () => void }) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const insets = useSafeAreaInsets();
  return (
    <View style={[uiStyles.header, { paddingTop: Math.max(insets.top, 24) }]}>
      {back && <IconButton icon={ArrowLeft} label="Back" onPress={onBack ?? (() => navigation.goBack())} />}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={uiStyles.title}>{title}</Text>
        {caption && <Text style={uiStyles.caption}>{caption}</Text>}
      </View>
      {!back && <IconButton icon={Settings} label="Settings" onPress={() => navigation.navigate("Settings")} />}
    </View>
  );
}

export const uiStyles = StyleSheet.create({
  recordingRing: { width: 176, height: 176, borderRadius: 88, borderWidth: 1, position: "absolute" },
  page: { flex: 1, backgroundColor: colors.background, width: "100%", maxWidth: 1040, alignSelf: "center" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 24, paddingBottom: 22 },
  title: { fontSize: 28, fontFamily: fonts.strong, color: colors.text, letterSpacing: 0 },
  caption: { fontSize: 12, fontFamily: fonts.body, color: colors.muted, marginTop: 5 },
  iconButton: { width: 44, height: 44, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  tooltip: { position: "absolute", width: 160, padding: 8, borderRadius: 6, backgroundColor: colors.text, zIndex: 30 },
  tooltipText: { fontSize: 12, lineHeight: 18, fontFamily: fonts.body, color: colors.surface },
  label: { fontSize: 12, fontFamily: fonts.strong, color: colors.muted, marginBottom: 12 },
  body: { fontSize: 14, fontFamily: fonts.body, color: colors.text, lineHeight: 22 },
  segmented: { flexDirection: "row", gap: 4, backgroundColor: colors.soft, padding: 4, borderRadius: 8 },
  segment: { flex: 1, minHeight: 44, borderRadius: 6, justifyContent: "center", alignItems: "center", paddingHorizontal: 8 },
  segmentActive: { backgroundColor: colors.surface, shadowColor: colors.text, shadowOpacity: 0.06, shadowRadius: 4, elevation: 1 },
  segmentText: { fontSize: 13, fontFamily: fonts.strong, color: colors.muted },
});
