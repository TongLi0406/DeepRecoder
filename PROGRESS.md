# DeepRecoder — Project Progress & Handoff

## Overview

One-tap meeting & classroom intelligence app. React Native (Expo SDK 56), TypeScript 6.0. Local-first, zero server. User brings DeepSeek API key. All data stored on-device (SQLite on native, in-memory Map on web).

**Repo**: https://github.com/TongLi0406/DeepRecoder
**Expo project**: @tongli0406/recorder (id: 44d7c040-9833-4c2c-9fd3-9cd23119917c)
**GitHub repo**: https://github.com/TongLi0406/DeepRecoder

## Build Status

- EAS cloud build **passed**: APK available at `npx eas build:list`
- Web dev server: `REACT_NATIVE_PACKAGER_HOSTNAME=<WSL2-IP> npx expo start --web --host lan`
- WSL2 IP: `172.22.198.170` (check with `ip addr show eth0 | grep inet`)

---

## What's Built (24 source files, ~4100 lines)

### Screens (7 files)

| File | Lines | Status | Description |
|------|-------|--------|-------------|
| `src/screens/HomeScreen.tsx` | 140 | Done | 4-mode selector grid, "Start Recording" button, "Try with sample audio" demo |
| `src/screens/RecordingScreen.tsx` | 325 | Done | Timer, waveform, pause/resume/stop, web simulation mode fallback, inline errors, session save on stop |
| `src/screens/SummaryScreen.tsx` | 364 | Done | Processes session after stop (calls LLM summarize), shows speaker-labeled transcript + structured summary, saves to storage |
| `src/screens/HistoryScreen.tsx` | 161 | Done | SectionList grouped by course, reloads on focus, navigates to summary review |
| `src/screens/SkillsScreen.tsx` | 180 | Done | Skill list with category badges, consolidation candidate count, "Run Consolidation" button |
| `src/screens/SearchScreen.tsx` | 213 | Done | Chat interface with RAG agent, source citations, keyboard avoiding view |
| `src/screens/SettingsScreen.tsx` | 206 | Done | API key input with show/hide, Save/Test Connection/Remove buttons, connection status |

### Services (15 files)

| File | Lines | Status | Description |
|------|-------|--------|-------------|
| `src/services/api.ts` | 129 | Done | DeepSeek API client (Anthropic-compatible endpoint), key CRUD via expo-secure-store/localStorage |
| `src/services/recording.ts` | 238 | Done | expo-av (native) / MediaRecorder + Web Speech API (web). Mic unavailable → auto simulation mode |
| `src/services/summarization.ts` | 197 | Done | 4 LLM prompt templates (student/teacher/organizer/attendee), speaker-labeled transcript, time-range titles |
| `src/services/storage.ts` | 181 | Done | Session CRUD: SQLite (native) / Map (web). Fields: id, createdAt, endTime, title, mode, phase, audioUri, transcript, summary, courseName, error |
| `src/services/skills.ts` | 169 | Done | Skill CRUD, pure-JS cosine similarity, n-gram textToEmbedding (128-dim), findConsolidationCandidates |
| `src/services/vectorStore.ts` | 192 | Done | Embedding CRUD, LLM embedding gen, cosine search, latency instrumentation with HNSW migration trigger |
| `src/services/extraction.ts` | 87 | Done | LLM skill extraction from transcripts, per-mode prompts (classroom: problem_solving/teaching_method; meeting: decision_pattern/meeting_practice/communication) |
| `src/services/consolidation.ts` | 183 | Done | Batched LLM merge (20 pairs/call), quickConsolidation (pure threshold 0.85), resource budget (MAX_SKILLS=1000) |
| `src/services/courses.ts` | 120 | Done | Course label extraction, embedding similarity matching, course grouping |
| `src/services/ragAgent.ts` | 179 | Done | Hybrid search (RRF fusion), RAG agent with hallucination detection (30% keyword overlap) |
| `src/services/offlineQueue.ts` | 170 | Done | Job queue (pending/processing/done/failed), connectivity check, drain/retry, 4 job types |
| `src/services/recovery.ts` | 97 | Done | Orphan recording recovery, session checkpoint recovery, disk space monitoring (<500MB warning), credit exhaustion detection |
| `src/services/security.ts` | 111 | Done | Log sanitization (sk- patterns, Bearer tokens), error sanitization, export data sanitization |
| `src/services/perf.ts` | 147 | Done | PerfMonitor, SLA compliance checks (<2s cold start, <500ms home render, <5s consolidation for 1000 skills) |
| `src/services/sampleData.ts` | 130 | Done | Pre-baked Chinese math class sample summary for "Try with sample" demo button |

### Other

| File | Description |
|------|-------------|
| `src/types/index.ts` | All TypeScript types: Session, SessionMode, SessionPhase, Summary types, Skill, ConsolidationCandidate, etc. |
| `src/navigation/AppNavigator.tsx` | 5 bottom tabs: Record, History, Skills, Search, Settings + native stack for Recording/Summary modals |
| `App.tsx` | Root: NavigationContainer, startup init (DB tables, recovery, offline queue drain), Stack navigator |
| `metro.config.js` | Adds `wasm` to assetExts (required for expo-sqlite web) |
| `eas.json` | EAS Build profiles: development, preview (APK), production |
| `.easignore` | Excludes node_modules, test-data, .git, etc. |
| `app.json` | Expo config: package=com.deeprecoder.app, owner=tongli0406, SDK 56 plugins |

---

## What's Working

1. **Web app loads and renders** — all 5 tabs functional, no blank screen
2. **Recording flow** — start → timer → pause/resume → stop → save session → navigate to summary
3. **Web simulation mode** — when mic unavailable (HTTP non-localhost), auto-falls-back to simulated recording (time-only, no audio)
4. **Summarization pipeline** — LLM call with mode-specific prompts, JSON parsing with fallback
5. **Speaker-labeled transcripts** — all prompts require the LLM to add speaker labels
6. **Title with time range** — auto-generated from recording start/end times
7. **History** — sessions load from storage, grouped by course, tap to review
8. **API key management** — save, test connection, remove (expo-secure-store on native, localStorage on web)
9. **TypeScript** — zero errors in `npx tsc --noEmit`
10. **EAS cloud build** — APK successfully built

## What's NOT Working / Incomplete

1. **Real microphone on web** — requires HTTPS or localhost. Current WSL2 setup (`http://172.22.198.170`) is neither. Falls back to simulation mode.
2. **Real STT (whisper.cpp)** — not integrated. Plan says Phase 1 should use API-based transcription, whisper.cpp deferred.
3. **Web Speech API** — code exists in recording.ts but only activates when `navigator.mediaDevices` exists (HTTPS/localhost only)
4. **Native (expo-av) recording** — not tested on real device (no native build run yet)
5. **Share button** — placeholder, no actual share implementation
6. **PDF/Markdown export** — not implemented
7. **Audio auto-delete after 7 days** — not implemented
8. **Background processing** — documented as v1 constraint (iOS limits to ~30s)
9. **SQLCipher encryption** — deferred to Phase 4
10. **Teacher analytics (v1 text)** — not implemented (participation metrics, question classification, engagement)

## Key Design Decisions

1. **Platform.OS branching everywhere** — every service file uses `Platform.OS === "web"` checks with dynamic `await import()` for native modules. Web uses in-memory stores, native uses expo-sqlite.
2. **Batched LLM merge** — skill consolidation sends 20 pairs in a single API call (decision #4)
3. **API-based transcription for v1** — whisper.cpp native bridge deferred (decision #3)
4. **"Try with sample" demo mode** — bypasses API key requirement for first use (decision #7)
5. **DeepSeek API via Anthropic compatibility layer** — endpoint: `api.deepseek.com/anthropic/v1/messages`, model: `deepseek-v4-pro`
6. **Pure-JS vector search** — 128-dim n-gram embeddings, cosine similarity. Instrumented with p95 latency tracking and HNSW migration trigger (>500ms streaks)

## Current Blockers

1. **No audio transcription** — the summarization pipeline expects a `transcript` field, but there's no STT. Web simulation mode produces empty transcripts. The LLM can generate a minimal summary from empty input, but quality is poor. Need either: (a) API-based transcription service, (b) whisper.cpp integration, or (c) Web Speech API on HTTPS.
2. **Web mic requires HTTPS** — for real web recording, need HTTPS or access via localhost.

## Next Steps (Priority Order)

1. **Add API-based transcription** — use DeepSeek or another API to transcribe audio files. This unblocks the entire pipeline for real recordings.
2. **Test on real Android device** — install the APK from EAS build, verify expo-av recording works natively.
3. **Implement share/export** — PDF/Markdown export, native share sheet.
4. **Audio storage management** — auto-delete raw audio after 7 days, keep vectorized summaries permanently.
5. **Teacher analytics** — participation metrics, question classification, teaching style detection.
6. **whisper.cpp integration** — on-device STT for offline use.
7. **SQLCipher encryption** — encrypt local SQLite database.

## Dev Commands

```bash
# Web dev server
REACT_NATIVE_PACKAGER_HOSTNAME=172.22.198.170 npx expo start --web --host lan --clear

# TypeScript check
npx tsc --noEmit

# EAS Android build (APK)
eas build --platform android --profile preview --non-interactive

# Check build status
eas build:list --platform android

# Git
git remote -v  # git@github.com:TongLi0406/DeepRecoder.git
```
