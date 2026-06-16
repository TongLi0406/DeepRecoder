# DeepRecoder

One-tap meeting & classroom intelligence app. Record, transcribe, and get AI-powered structured summaries — all on-device, with your own API key.

## Features

- **One-tap recording** — Start recording meetings or classes instantly
- **4 role-based modes** — Meeting Organizer, Meeting Attendee, Classroom Student, Classroom Teacher
- **AI summarization** — Structured summaries with speaker-labeled transcripts, knowledge points, decisions, action items
- **Speaker labels** — Auto-identified speaker attribution (Speaker A/B, Teacher/Student)
- **Knowledge base** — Vector embeddings with hybrid search (semantic + keyword via RRF fusion)
- **Skill extraction** — Automatic skill/pattern extraction with LLM-powered consolidation
- **Offline queue** — Jobs queue with retry logic for intermittent connectivity
- **RAG agent** — Built-in Q&A agent with hallucination detection
- **Local-first** — All data stays on-device (SQLite + in-memory), zero server infrastructure
- **Cross-platform** — iOS, Android, and Web (with adaptive fallbacks)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native (Expo SDK 56) |
| Language | TypeScript 6.0 |
| Audio | expo-av (native) / MediaRecorder API (web) |
| STT | Web Speech API (web) / whisper.cpp (native, planned) |
| LLM | DeepSeek API (Anthropic-compatible endpoint) |
| Database | expo-sqlite (native) / In-memory Map (web) |
| Vector Search | Pure-JS cosine similarity (128-dim n-gram embeddings) |
| Navigation | react-navigation (bottom tabs + native stack) |

## Architecture

```
src/
├── screens/         # 7 screens (Home, Recording, Summary, History, Skills, Search, Settings)
├── services/        # 15 service modules
│   ├── api.ts           # DeepSeek API client + API key management
│   ├── recording.ts     # Audio recording (expo-av / MediaRecorder + Web Speech API)
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

- Node.js 18+
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

# Android
npx expo start --android
```

### Configure API Key

Open the app → Settings tab → enter your DeepSeek API key → tap "Test Connection"

The key is stored in:
- **iOS/Android**: Secure enclave (expo-secure-store)
- **Web**: localStorage (dev only; use native for production)

## How It Works

1. **Select mode** — Choose Meeting Organizer/Attendee or Classroom Student/Teacher
2. **Record** — One tap starts recording. Web Speech API captures real-time transcript (web) or whisper.cpp (native).
3. **Stop & Process** — Stop generates a structured summary via DeepSeek API:
   - Classroom: knowledge points, problem-solving approaches, lesson connections
   - Meeting: decisions, action items, key points, attendees
4. **Review** — All recordings saved in History, grouped by course/meeting
5. **Search** — Ask questions against your knowledge base; RAG agent answers with citations

## Web Limitations

- Microphone requires HTTPS or localhost (falls back to simulation mode on HTTP)
- Web Speech API quality varies by browser
- expo-sqlite and expo-secure-store use in-memory/localStorage fallbacks on web

## License

MIT
