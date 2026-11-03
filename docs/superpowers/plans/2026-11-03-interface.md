# Recorder Interface Implementation Plan

> Use executing-plans inline with focused test cycles. No commits or worktrees: this
> workspace has no Git metadata. User approved the design and restrained visual motion.

**Goal:** Deliver a task-first interface without changing the audio or processing architecture.

**Architecture:** One small shared UI module owns visual tokens, accessible command
buttons, headers and motion. Existing screens continue to call existing services.
Library composes History and Skills rather than duplicating their data paths.

**Tech Stack:** Expo SDK 56, React Native Animated, Lucide/react-native-svg, bundled fonts.

## Global Constraints

- Follow the approved interface spec and SDK 56 documentation.
- Preserve recording ownership, consent, source validation, queues and existing routes.
- No fabricated microphone waveform, sample diary, native availability or backend change.
- Stop motion loops offscreen/backgrounded; honor reduced motion.

## Task 1: Foundation and Navigation

Files: src/ui.tsx, src/navigation/AppNavigator.tsx, App.tsx, src/screens/LibraryScreen.tsx,
package.json and existing test-data/pipeline.test.cjs.

- [x] Install Expo-compatible font/SVG packages and Lucide; use bundled font assets.
- [x] Add shared colors/typography, IconButton, ScreenHeader, PageEntrance and RecordingPulse.
- [x] Add four main tabs, a Library recordings/skills selector and a Settings stack route.
- [x] Typecheck and verify navigation with browser accessibility snapshots.

Contract: `ScreenHeader({title, back?})`, `IconButton({label, icon, onPress, disabled?})`,
`PageEntrance({children, style?})`, `RecordingPulse({active})`; controls retain labels.

## Task 2: Recording and Diary

Files: HomeScreen.tsx, RecordingScreen.tsx, DiaryScreen.tsx and existing audio/diary tests.

- [x] Extend recording render tests for explicit autoStart and ownership protection.
- [x] Replace four large mode cards with compact selectors and recent real recordings.
- [x] Start through `Recording: {mode, autoStart?: boolean}`; remove the inert Flag control
  and decorative waveform; show real elapsed duration with the state-driven ring.
- [x] Add diary rendering assertions: content precedes settings, native controls are absent
  on Web, and collapsed tools preserve existing review/deletion APIs.
- [x] Reorder diary and keep settings/segment panels collapsed by default.
- [x] Run `node --test test-data/audio.test.cjs test-data/diary.test.cjs` then typecheck.

Focused expectations include:
```js
assert.ok(html.indexOf('Daily Diaries') < html.indexOf('Diary Settings'));
assert.ok(!html.includes('Prepare Models'));
assert.equal(cleanupCalls, ownsCapture ? 1 : 0);
```

## Task 3: Remaining Surfaces and Verification

Files: HistoryScreen.tsx, SkillsScreen.tsx, SearchScreen.tsx, SettingsScreen.tsx,
SummaryScreen.tsx, existing README.md and TEST_REPORT.md.

- [x] Apply shared colors/fonts and unframed layout; preserve all functional controls.
- [x] Use icons for navigation, send, export and destructive commands; expose accessible names.
- [x] Run all four existing Node test files, TypeScript and Web export.
- [x] Verify navigation and responsive layout using Playwright screenshots at desktop/mobile.
- [x] Verify reduced-motion styling and background/unfocused loop stop behavior.
- [x] Update the existing validation report; leave Android/hardware gates open.

Verification follow-up repaired existing storage error propagation and cache ordering,
failed-record retry subscriptions, native/Web removal confirmation and list error states.
These retain the existing services and processing architecture. Final result: 48 passing
checks, Web export and post-export typecheck; hardware limitations remain in TEST_REPORT.md.

Commands:
```sh
node --test test-data/pipeline.test.cjs test-data/audio.test.cjs test-data/diary.test.cjs test-data/native-diary.test.cjs
node node_modules/typescript/bin/tsc --noEmit
npx --no-install expo export --platform web
```
