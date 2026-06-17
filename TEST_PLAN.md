# DeepRecoder — Full Functional Test Plan

## Environment

- **Platform**: Web (WSL2, `http://172.22.198.170`)
- **Node**: 18+
- **Expo SDK**: 56
- **TypeScript**: 6.0

## Prerequisites

1. `npm install` completed
2. Dev server running: `REACT_NATIVE_PACKAGER_HOSTNAME=172.22.198.170 npx expo start --web --host lan --clear`
3. Browser open at `http://172.22.198.170:8081`
4. DeepSeek API key ready (for API-dependent tests)

---

## T1: App Startup & Initialization

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 1.1 | Cold start loads without crash | Open browser to dev URL | App renders, no blank screen, 5 bottom tabs visible | |
| 1.2 | Tab bar visible | Check bottom of screen | 5 tabs: Record (home icon), History, Skills, Search, Settings | |
| 1.3 | Default tab is Record (Home) | On load | HomeScreen renders with 4 mode cards | |
| 1.4 | Title and subtitle visible | Home screen | "Recorder" title + "One-tap meeting & classroom intelligence" subtitle | |
| 1.5 | Start button disabled by default | Home screen | "Select a mode above" text, button is grayed (#DADCE0 background) | |

## T2: Home Screen — Mode Selection

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 2.1 | Select Meeting Organizer | Tap the "Meeting — Organizer" card | Card highlights with blue border (#1A73E8) and blue bg (#E8F0FE), button text changes to "Start Recording" | |
| 2.2 | Select Meeting Attendee | Tap "Meeting — Attendee" card | Same highlight, previous selection deselected | |
| 2.3 | Select Classroom Student | Tap "Classroom — Student" card | Same highlight | |
| 2.4 | Select Classroom Teacher | Tap "Classroom — Teacher" card | Same highlight | |
| 2.5 | Only one selected at a time | Select one, then another | Previous card reverts to unselected style | |
| 2.6 | Deselect by tapping same card | Select a card, tap it again | Card stays selected (no toggle off) | |
| 2.7 | Mode cards display correctly | Observe all 4 cards | Each shows icon, title, and description text | |

## T3: Recording Flow — Start

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 3.1 | Start recording after selecting mode | Select any mode → tap "Start Recording" | Navigate to Recording screen, show "Tap to start" button | |
| 3.2 | Mode label displayed | On Recording screen | Correct mode label shown (e.g., "Classroom · Student") | |
| 3.3 | Cancel button works | Tap "Cancel" | Navigate back to Home screen | |
| 3.4 | No mode → can't start | Don't select mode → verify button disabled | Button shows "Select a mode above", tap does nothing | |

## T4: Recording Flow — Record

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 4.1 | Tap record button | Tap the red circle button | Recording starts, timer begins counting up from 00:00 | |
| 4.2 | Timer increments | Wait 5+ seconds | Timer shows elapsed time (00:01, 00:02, ...) | |
| 4.3 | Waveform bars visible | During recording | Waveform placeholder bars shown | |
| 4.4 | Simulated mode banner | On HTTP (non-localhost) web | Yellow banner "Simulation mode (mic unavailable)" appears | |
| 4.5 | Controls visible | During recording | Pause, Stop (red square), and Flag buttons visible | |
| 4.6 | Error state | Mic unavailable on non-HTTPS | Recording still works in simulation mode, no crash | |

## T5: Recording Flow — Pause & Resume

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 5.1 | Pause recording | Tap "Pause" during recording | Timer stops, button text changes to "Resume", waveform bar turns yellow | |
| 5.2 | Resume recording | Tap "Resume" | Timer resumes, button text changes back to "Pause", waveform bar back to red | |
| 5.3 | Multiple pause/resume cycles | Pause → Resume → Pause → Resume | Timer continues correctly, no drift | |
| 5.4 | Pause stops timer | Pause, wait 3s, resume | Timer should not have advanced during pause | |

## T6: Recording Flow — Stop & Save

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 6.1 | Stop recording | Tap stop button (red square) | Recording stops, session saved, navigates to Summary screen | |
| 6.2 | Stop button disabled during stopping | Tap stop rapidly | Only one stop processed, no crash | |
| 6.3 | Back navigation blocked while recording | Press browser back / device back during recording | Error message "Stop recording before leaving." displayed | |
| 6.4 | Session data preserved | After stop → Summary screen | Session has correct mode, createdAt, endTime, audioDuration | |
| 6.5 | Simulated recording saves | Stop in simulation mode | Session saved with empty audioUri, duration from timer | |

## T7: Summary Screen — Processing

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 7.1 | Loading state shown | After stop, before LLM response | "Processing..." text + ActivityIndicator spinner visible | |
| 7.2 | Time range displayed | Summary screen | Shows "startTime — endTime" in format "2026/6/17 14:30:00 — 14:35:00" | |
| 7.3 | Processing hint text | During processing | "Transcribing and analyzing your recording" hint visible | |

## T8: Summary Screen — With API Key (4 Modes)

### T8A: Classroom Student Mode

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8A.1 | Student summary sections | Complete recording in student mode with API key | Shows: Knowledge Points, Problem-Solving Approaches, (optional) Lesson Connections | |
| 8A.2 | Knowledge point cards | View knowledge points | Each card shows name, description, mastery hint | |
| 8A.3 | Problem approach cards | View approaches | Each card shows approach name, procedure | |
| 8A.4 | Empty state handling | Empty transcript → LLM returns no items | "No knowledge points identified" / "No approaches identified" shown | |
| 8A.5 | Speaker-labeled transcript | After processing | Transcript section shows speaker labels (老师/学生) | |
| 8A.6 | Title generated | After processing | Title includes course topic and time range | |

### T8B: Classroom Teacher Mode

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8B.1 | Teacher-specific sections | Complete recording in teacher mode | Shows: Teaching Style, Interaction Level, Teaching Structure, Question Analysis | |
| 8B.2 | Teaching structure cards | View structure | Each shows section name, description, duration hint | |
| 8B.3 | Question type cards | View questions | Each shows type, count (xN), quality, examples | |
| 8B.4 | Improvement suggestions | View suggestions | List of improvement items displayed | |
| 8B.5 | Also includes student sections | Below teacher sections | Knowledge Points, Problem Approaches also shown (TeacherSummary extends StudentSummary) | |

### T8C: Meeting Organizer Mode

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8C.1 | Organizer sections | Complete recording in organizer mode | Shows: Decisions, Action Items, Key Points | |
| 8C.2 | Decision cards | View decisions | Each shows content + context | |
| 8C.3 | Action item cards | View action items | Each shows content, assignee, deadline (if present) | |
| 8C.4 | Key points list | View key points | Bulleted list of key discussion points | |

### T8D: Meeting Attendee Mode

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 8D.1 | Attendee sections | Complete recording in attendee mode | Shows: Decisions, Action Items, Key Points (personal perspective) | |
| 8D.2 | Personal focus | Content filtered | Action items and decisions relevant to "me" | |

## T9: Summary Screen — Error Handling

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 9.1 | No API key configured | Complete recording without setting API key | Error card: "Processing Error" + error message about missing API key | |
| 9.2 | Invalid API key | Set wrong API key, record | Error card with API error message | |
| 9.3 | Network error | Disconnect network, record | Error card with network error message | |
| 9.4 | Empty transcript warning | Record with no speech (simulation) | Warning card: "No transcript captured" with explanation | |
| 9.5 | Raw transcript shown on error | When error occurs and transcript exists | Raw transcript displayed below error card | |

## T10: Summary Screen — Actions

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 10.1 | Done button | Tap "Done" | Navigate back to Home (popToTop) | |
| 10.2 | Share button exists | View bottom bar | Share button visible (note: not yet functional — placeholder) | |
| 10.3 | Share button tap | Tap Share | Currently does nothing (no crash expected) | |

## T11: History Screen

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 11.1 | Empty state | No recordings yet | "No recordings yet" message with icon | |
| 11.2 | Sessions grouped by course | Complete 2+ recordings | Sessions grouped under course names with session count | |
| 11.3 | Section headers | View grouped sessions | Each group shows course name + "N sessions" count | |
| 11.4 | Session item display | View a session | Shows topic (or "Untitled"), date ("Today"/"Yesterday"/formatted) | |
| 11.5 | Tap session to review | Tap a session item | Navigate to Summary screen with that session's data | |
| 11.6 | Reload on tab focus | Complete recording → switch to History tab → switch back | Data reloads, new session appears | |
| 11.7 | Date formatting | View sessions from today, yesterday, older | Today = "Today", yesterday = "Yesterday", older = "Jun 15" format | |

## T12: Skills Screen

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 12.1 | Empty state | No skills extracted | "No skills yet. Record sessions to build your skill library." message | |
| 12.2 | Skill list display | After recording with LLM extraction | Skills shown with name, category badge, description, use count, session count | |
| 12.3 | Category badges | View skill cards | Each shows category label (Problem Solving, Teaching Method, etc.) | |
| 12.4 | Consolidation candidates count | View header | "N skills extracted · M merge candidates" subtitle | |
| 12.5 | Run Consolidation button | When candidates > 0 | Blue button "Run Consolidation (N candidates)" visible | |
| 12.6 | Consolidation success | Tap consolidation button | Alert: "Merged X skill pairs. Y skipped." → list refreshes | |
| 12.7 | Consolidation no candidates | When candidates = 0 | Alert: "No skills to merge yet..." → list refreshes | |
| 12.8 | Merged skill info | View a merged skill | "Merged from N skills" text shown in blue | |

## T13: Search Screen (RAG Agent)

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 13.1 | Initial message | Open Search tab | Agent greeting: "Ask me anything about your recorded meetings and classes..." | |
| 13.2 | Input field | View input bar | Text input with "Ask a question..." placeholder, Send button | |
| 13.3 | Send button disabled when empty | No text in input | Send button grayed out (#DADCE0) | |
| 13.4 | Send question with API key | Type question → tap Send | User bubble appears (blue, right-aligned), loading indicator, agent response | |
| 13.5 | Agent response bubble | After response | Agent bubble (gray, left-aligned) with answer text | |
| 13.6 | Source citations | Response with sources | "Sources (N)" section with up to 3 source snippets | |
| 13.7 | Ungrounded warning | When grounded=false | "Sources (N) — may contain unverified info" shown | |
| 13.8 | Multiple questions | Send 3+ questions | All messages appear in scrollable chat, auto-scrolls to bottom | |
| 13.9 | Empty question rejected | Tap Send with empty input | Nothing happens | |
| 13.10 | Loading state | During API call | Send button shows ActivityIndicator, input disabled | |
| 13.11 | Error handling | No API key / network error | Error message appears in agent bubble | |
| 13.12 | Keyboard behavior | Input focused on iOS | KeyboardAvoidingView adjusts layout (iOS only) | |

## T14: Settings Screen

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 14.1 | Initial state | Open Settings tab | Empty input field with "sk-..." placeholder, no status badge | |
| 14.2 | Show/Hide key | Tap "Show" button | Input switches to visible text, button text changes to "Hide" | |
| 14.3 | Hide key | Tap "Hide" | Input switches back to secureTextEntry | |
| 14.4 | Save empty key | Tap Save with empty input | Alert: "Error" — "Please enter an API key" | |
| 14.5 | Save valid key | Enter key → tap Save | Alert: "Saved" — "API key saved securely on-device" | |
| 14.6 | Key persisted | Save key → close tab → reopen Settings | Key still shown in input field | |
| 14.7 | Test Connection — valid key | Tap "Test Connection" with valid key | Loading spinner → Alert: "Connected" → green badge "Connection OK" | |
| 14.8 | Test Connection — invalid key | Enter wrong key → Test | Loading spinner → Alert: "Failed" → red badge "Connection Failed" | |
| 14.9 | Test Connection — network error | Disconnect network → Test | Alert: "Error" — "Connection test failed" | |
| 14.10 | Test button disabled during test | Tap Test Connection | Button shows spinner, disabled during test | |
| 14.11 | Remove key | When key exists → tap "Remove Key" | Alert: "Removed" → input clears, "Remove Key" button disappears | |
| 14.12 | Remove key not shown when none | No key saved | "Remove Key" button not visible | |
| 14.13 | Data section info | View Settings | Text about audio recordings and knowledge base storage | |
| 14.14 | About section | View Settings | "Recorder v1.0.0" and description text | |

## T15: Demo Mode ("Try with sample audio")

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 15.1 | Demo button always visible | Home screen | "Try with sample audio" link below Start Recording | |
| 15.2 | Demo uses selected mode | Select "classroom-student" → tap demo | Summary screen opens with student-mode sample summary | |
| 15.3 | Demo with no mode selected | Don't select mode → tap demo | Defaults to "classroom-student" mode | |
| 15.4 | Demo skips API key check | No API key configured → tap demo | Summary screen shows sample data immediately (no API call) | |
| 15.5 | Demo summary structure | View demo summary | Shows Chinese math class sample with knowledge points, problem approaches | |
| 15.6 | Demo session in history | Complete demo → go to History | Demo session appears in history list | |
| 15.7 | 4 modes of demo | Try demo with each mode selected | Each shows mode-appropriate sample summary | |

## T16: Navigation & Tab Bar

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 16.1 | Tab switching | Tap each of 5 tabs | Correct screen loads for each tab | |
| 16.2 | Active tab indicator | Tap different tabs | Current tab highlighted | |
| 16.3 | Back from Recording | Tap Cancel on Recording screen | Returns to Home tab | |
| 16.4 | Back from Summary | Tap Done on Summary screen | Returns to Home (popToTop) | |
| 16.5 | Modal flow (Recording → Summary) | Complete recording | Recording screen replaced by Summary (navigation.replace) | |
| 16.6 | History → Summary navigation | Tap session in History | Summary screen opens with full session data | |

## T17: TypeScript & Build

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 17.1 | TypeScript check passes | `npx tsc --noEmit` | Zero errors | |
| 17.2 | Web dev server starts | `npx expo start --web` | No errors, serves on port 8081 | |
| 17.3 | Hot reload works | Edit a file, save | Browser updates without full refresh | |

## T18: Edge Cases & Robustness

| # | Case | Steps | Expected | Pass |
|---|------|-------|----------|------|
| 18.1 | Long recording (10min+) | Record for 10+ minutes in simulation | Timer continues correctly, no overflow | |
| 18.2 | Rapid tab switching | Switch tabs rapidly 20+ times | No crash, no blank screens | |
| 18.3 | Double-tap start recording | Quickly double-tap record button | Only one recording starts | |
| 18.4 | Browser refresh during recording | Refresh page while recording | Recording lost, app reinitializes cleanly | |
| 18.5 | Very long transcript | Paste/record very long text | Summary screen scrolls, no layout break | |
| 18.6 | Unicode content | API returns Chinese/special characters | Renders correctly in summary | |
| 18.7 | Concurrent API calls | Rapidly send multiple search queries | Queued or last-one-wins, no crash | |

---

## Test Execution Order

1. **T17** — Verify build compiles (prerequisite)
2. **T1** — App startup
3. **T2** — Mode selection
4. **T16** — Navigation basics
5. **T14** — Settings (set API key)
6. **T15** — Demo mode (no API needed)
7. **T3–T6** — Recording flow
8. **T7–T10** — Summary flow
9. **T11** — History
10. **T12** — Skills
11. **T13** — Search/RAG
12. **T18** — Edge cases

## Notes

- Web simulation mode (T4.4) will be the default on HTTP WSL2 setup — real mic only works on HTTPS or localhost
- Summary quality depends on API key validity and transcript content
- Share button (T10.2–10.3) is a placeholder — no crash expected, no functionality
- whisper.cpp native STT not integrated — transcript will be empty in simulation mode
