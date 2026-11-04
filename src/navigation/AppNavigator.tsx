import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import HomeScreen from "../screens/HomeScreen";
import LibraryScreen from "../screens/LibraryScreen";
import SearchScreen from "../screens/SearchScreen";
import DiaryScreen from "../screens/DiaryScreen";
import { BookOpen, Library, MessagesSquare, Mic, type LucideIcon } from "lucide-react-native";
import { colors, fonts, useReducedMotion } from "../ui";

const Tab = createBottomTabNavigator();

const icons: Record<string, LucideIcon> = { Home: Mic, Diary: BookOpen, Library, Search: MessagesSquare };

export default function AppNavigator() {
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const wide = useWindowDimensions().width >= 900;

  return (
    <Tab.Navigator
      screenOptions={({ route }) => {
        const Icon = icons[route.name];
        return {
        headerShown: false, animation: reduced ? "none" : "fade",
        tabBarPosition: wide ? "left" : "bottom",
        tabBarLabelPosition: wide ? "beside-icon" : "below-icon",
        tabBarIcon: ({ color }) => <Icon size={22} color={color} strokeWidth={1.7} />,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        tabBarActiveBackgroundColor: colors.soft,
        tabBarStyle: {
          borderTopColor: colors.line, borderRightColor: colors.line,
          backgroundColor: colors.surface,
          ...(wide ? { width: 180, minWidth: 180, paddingTop: 32, paddingHorizontal: 10 }
            : { paddingBottom: Math.max(insets.bottom, 6), height: 64 + insets.bottom }),
        },
        tabBarItemStyle: wide ? { minHeight: 52, borderRadius: 8, marginBottom: 6 } : undefined,
        tabBarLabelStyle: { fontSize: 12, fontFamily: fonts.strong },
      };}}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarLabel: "录音" }}
      />
      <Tab.Screen
        name="Diary"
        component={DiaryScreen}
        options={{ tabBarLabel: "日记" }}
      />
      <Tab.Screen
        name="Library"
        component={LibraryScreen}
        options={{ tabBarLabel: "资料库" }}
      />
      <Tab.Screen
        name="Search"
        component={SearchScreen}
        options={{ tabBarLabel: "提问" }}
      />
    </Tab.Navigator>
  );
}
