import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import HistoryScreen from "./HistoryScreen";
import SkillsScreen from "./SkillsScreen";
import { colors, ScreenHeader, uiStyles } from "../ui";

export default function LibraryScreen() {
  const [selected, setSelected] = useState("Recordings");
  return (
    <View style={uiStyles.page}>
      <ScreenHeader title="Library" />
      <View style={[uiStyles.segmented, { marginHorizontal: 24, marginBottom: 16 }]}>
        {["Recordings", "Skills"].map(label => (
          <Pressable key={label} accessibilityRole="tab" accessibilityState={{ selected: selected === label }}
            onPress={() => setSelected(label)} style={[uiStyles.segment, selected === label && uiStyles.segmentActive]}>
            <Text style={[uiStyles.segmentText, selected === label && { color: colors.accent }]}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {selected === "Recordings" ? <HistoryScreen /> : <SkillsScreen />}
    </View>
  );
}
