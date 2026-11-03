# DeepRecoder

One-tap meeting & classroom intelligence app with Android diary capture. Record locally and generate structured summaries with your own API keys. Configured providers receive transcription audio and/or LLM text; this is not a fully offline app.

## Features

- **One-tap recording** — Start recording meetings or classes instantly
- **4 role-based modes** — Meeting Organizer, Meeting Attendee, Classroom Student, Classroom Teacher
- **Task-first interface** - Record, Diary, Library and Ask; recordings and skills share Library. Bundled fonts, labelled icons and restrained transitions honor reduced motion
- **Long-recording processing** - Bounded transcript chunks, recursive fact reduction, persisted checkpoints, and model-specific request budgets; original transcripts remain local
- **AI summarization** - Structured knowledge points, decisions and action items without asking the model to reproduce the full transcript
- **Android diary mode** - Consented foreground microphone service, speech-only segments, local encrypted voice enrollment, sourced daily summaries and manual identity correction
- **Conservative identity** - Local voice matching is probabilistic; short, mixed or uncertain speech stays unknown. Text labels do not prove who spoke
- **Knowledge base** — Vector embeddings with hybrid search (semantic + keyword via RRF fusion)
- **Skill extraction** — Automatic skill/pattern extraction with LLM-powered consolidation
- **Offline queue** — Jobs queue with retry logic for intermittent connectivity
- **RAG agent** - Built-in Q&A with bounded source excerpts; citations are references, not proof of correctness
- **Local-first** - On-device storage, no app-owned server; remote providers receive only the configured processing inputs. Voice templates are not uploaded
- **Cross-platform** - Meeting/classroom interface on iOS, Android and Web; diary capture is Android-only and requires a custom native build

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native (Expo SDK 56) |
| Language | TypeScript 6.0 |
| Audio | Custom PCM module / expo-audio (native fallback) / MediaRecorder (web) |
| Diary | Android foreground service, sherpa-onnx VAD and local speaker embeddings |
| STT | Web Speech API / whisper.rn / remote SiliconFlow SenseVoiceSmall |
| LLM | Configurable HTTPS model, context limit and API format; DeepSeek default |
| Database | expo-sqlite (native) / In-memory Map (web) |
| Vector Search | Pure-JS cosine similarity (128-dim n-gram embeddings) |
| Navigation | react-navigation (bottom tabs + native stack) |

## Architecture

```
src/
├── screens/         # Home, Recording, Summary, History, Skills, Search, Settings, Diary
├── services/
│   ├── api.ts           # DeepSeek API client + API key management
│   ├── recording.ts     # PCM / expo-audio / MediaRecorder recording
│   ├── llmContext.ts    # Bounded splitting and recursive reduction
│   ├── diary.ts         # Consent, serial processing and sourced daily generation
│   ├── diaryStorage.ts  # Segments, daily versions and retention
│   ├── summarization.ts # LLM summarization prompts per mode
│   ├── storage.ts       # Session CRUD (SQLite / in-memory)
│   ├── skills.ts        # Skill CRUD + cosine similarity + consolidation candidates
│   ├── vectorStore.ts   # Embedding storage + vector search
│   ├── extraction.ts    # LLM skill extraction from transcripts
│   ├── consolidation.ts # Batched LLM skill merge
│   ├── courses.ts       # Course grouping + embedding matching
│   ├── ragAgent.ts      # Hybrid search + RAG Q&A agent
│   ├── offlineQueue.ts  # Job queue with retry + connectivity check
│   ├── recovery.ts      # Crash recovery + disk space monitoring
│   ├── security.ts      # Log/error sanitization
│   ├── perf.ts          # Performance monitoring + SLA checks
│   └── sampleData.ts    # Demo data for "Try with sample"
├── types/
│   └── index.ts     # All TypeScript types
└── navigation/
    └── AppNavigator.tsx # Tab + stack navigation
```

## Getting Started

### Prerequisites

- Node.js 24 LTS (validation used 24.15.0)
- Expo CLI (`npx expo`)
- A [DeepSeek API key](https://platform.deepseek.com/)

### Install

```bash
git clone https://github.com/TongLi0406/DeepRecoder.git
cd DeepRecoder
npm install
```

### Run

```bash
# Web
npx expo start --web

# iOS
npx expo start --ios

# Android custom build (requires configured JDK and Android SDK)
node modules/pcm-recorder/android/scripts/setup-native-diary.js
npx expo run:android
```

### Configure API Key

Open Settings from the header gear icon. Configure the HTTPS endpoint, model, API format and context limit, then save your API key and tap "Test Connection". Saving or deleting keys reports persistence failures rather than claiming success.

The key is stored in:
- **iOS/Android**: expo-secure-store
- **Web**: localStorage (dev only; use native for production)

## How It Works

1. **Select mode** — Choose Meeting Organizer/Attendee or Classroom Student/Teacher
2. **Record** - Capture audio; web speech, local Whisper or configured remote STT supplies the transcript.
3. **Stop & Process** — Stop generates a structured summary via DeepSeek API:
   - Classroom: knowledge points, problem-solving approaches, lesson connections
   - Meeting: decisions, action items, key points, attendees
4. **Review** - Open Library > Recordings. Summaries show conclusions before an expandable original transcript; failed processing can be retried. Leaving ongoing processing requires confirmation.
5. **Search** - Use Ask for questions against your knowledge base; RAG agent answers with source excerpts.

Summary and skill exports offer Markdown download or an independent PDF print preview on Web; native builds use file sharing. Web PDF export requires pop-ups to be allowed.

## Android Diary

1. Build the custom Android app; Expo Go does not include the diary native module.
2. Configure LLM settings and a SiliconFlow STT key in Settings. Open Diary Settings from Diary and grant consent only after obtaining authorization from recorded participants and confirming applicable local requirements.
3. In Diary Settings, prepare models and enroll a 15-30 second solo voice sample. Enrollment audio is deleted after success or failure; the encrypted voice template stays local.
4. Start capture while the app is foregrounded. The microphone foreground service continues with a visible notification; pause/stop controls remain available. Ordinary recording and diary capture are mutually exclusive.
5. On foreground re-entry, import and process pending segments, then generate or update the selected day's diary. JS processing is not guaranteed at midnight or while the app is backgrounded.
6. Review neutral summaries, timeline, topics, commitments and source IDs. Correct uncertain segment identity manually; identity changes invalidate derived diary content until regeneration.

Web previews hide unavailable native diary capture and enrollment controls. On Android, pause/resume/stop depend on capture state. Pausing either recording mode does not release its ownership: stop it before switching modes. A Record page that never started its own capture must not clean up an ongoing enrollment recording.

Raw audio retention can be 1, 7 or 30 days. Unprocessed backlog is reported, not silently deleted. Revoking consent cancels in-flight processing; it cannot undo audio/text already received by a provider. Audio, voice-profile and derived-data deletion controls are separate.

Speech-only segmentation and disk/battery/thermal guards are implemented, but daily power consumption, OEM background reliability and voice-match accuracy have **not** been measured on a device. Unknown is not equivalent to another identified speaker; overlapping multi-person speech is not fully diarized.

## Verification

Run the software checks from the project root:

```bash
node --test test-data/pipeline.test.cjs test-data/audio.test.cjs test-data/diary.test.cjs test-data/native-diary.test.cjs
node node_modules/typescript/bin/tsc --noEmit
npx --no-install expo export --platform web
```

Latest run: 48 tests passed, Web export passed, and TypeScript passed again after export. The TypeScript configuration excludes generated output while preserving Expo's standard exclusions. Native artifact hashes and source-contract checks do not replace Kotlin compilation or hardware tests. See [TEST_REPORT.md](TEST_REPORT.md) for interface coverage and open Android validation gates.

## Web Limitations

- Microphone requires HTTPS or localhost (falls back to simulation mode on HTTP)
- Web Speech API quality varies by browser
- expo-sqlite and expo-secure-store use in-memory/localStorage fallbacks on web

## License

MIT
