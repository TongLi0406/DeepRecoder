<!-- /autoplan restore point: /home/tongli123/.gstack/projects/Recorder/master-autoplan-restore-20260616-195536.md -->
# Implementation Plan: Recorder App

Generated from design doc: tongli123-unknown-design-20260616-185724.md
Date: 2026-06-16

## Phase 1: Foundation (Weeks 1-4)

### 1.1 Project Scaffold
- Initialize React Native (Expo) project
- Set up navigation (React Navigation, bottom tabs)
- Create screen skeletons: Home, Recording, Summary, History, Search/Agent, Settings

### 1.2 Audio Recording Pipeline
- expo-av audio capture with incremental chunk saving (every 5s)
- Recording screen UI: timer, waveform, pause/resume, stop
- Local file storage for audio chunks
- Audio chunk concatenation before processing

### 1.3 On-Device Transcription
- Integrate whisper.cpp (GGML small model, ~500MB)
- Model download on first launch
- Transcription job queue (pending → processing → done → failed)
- Fallback heuristics for low-quality audio

### 1.4 API Key Management
- Settings screen: API key input, test connection button
- expo-secure-store for Keychain/Keystore storage
- API key validation via lightweight test call
- Cost preview before processing (estimated tokens)

### 1.5 Structured Summarization
- Mode selector: Meeting (Organizer/Attendee), Classroom (Student/Teacher)
- LLM prompt templates for each mode + sub-mode
- Streaming results display (decisions first, then details)
- Edit and share (PDF/Markdown export, native share sheet)

## Phase 2: Knowledge Layer (Weeks 5-8)

### 2.1 Vector Storage
- SQLite schema for sessions, transcripts, summaries, embeddings
- Pure-JS cosine similarity for vector search (<10K vectors target)
- Embedding generation via LLM API on summary text
- Storage management: auto-delete raw audio after 7 days

### 2.2 RAG Agent
- Search screen: hybrid keyword + semantic search
- Agent chat interface: user question → embed → retrieve top-K → LLM with context
- Source citations in agent responses
- Agent answers grounded in knowledge base content

### 2.3 Course Auto-Classification
- LLM extracts course label from transcript content
- Embedding similarity comparison against existing courses (>0.8 threshold)
- User override: rename/merge/reassign courses
- Course grouping in History view

## Phase 3: Skills Engine (Weeks 9-12+)

### 3.1 Skill Extraction
- Skill data model: id, name, description, category, embedding, source sessions
- Extraction prompts per mode (meeting approaches, problem-solving methods, teaching styles)
- Skills stored alongside session data

### 3.2 Skill Consolidation
- Background task: cosine similarity on unmerged skills within same category
- Resource budget: max 1 run/launch, ≤1000 skills (O(n^2)), battery >20%, cancels on background
- LLM-mediated merge decisions above 0.85 similarity threshold
- Modal prompt on home screen when consolidation results ready
- Manual override: Settings > Skills > "Run consolidation now"

### 3.3 Teacher Analytics (v1 — Text Only)
- Participation metrics: unique speakers, speaking-time distribution, question count
- Question classification: factual-recall, application, synthesis, open-ended
- Teaching style: lecture-heavy, interactive, discussion-driven, exercise-based
- Visual charts deferred to v2

## Phase 4: Polish & Ship (Weeks 13-16)

### 4.1 Error Handling & Recovery
- Recording interruption recovery (incremental chunk saving)
- API credit exhaustion → partial results saved, resume from checkpoint
- Malformed LLM output → retry with stricter prompt, fallback to raw transcript
- Disk space monitoring (<500MB warning)
- Offline queue with status badges

### 4.2 Distribution
- iOS: App Store submission (Apple Developer account)
- Android: Google Play Store + direct APK
- CI/CD: GitHub Actions for build/test
- Over-the-air updates via Expo (non-native changes)

## Open Technical Risks
1. **Vector DB on mobile:** Pure-JS similarity search may degrade above 10K vectors. Fallback: HNSW index.
2. **whisper.cpp on React Native:** Requires native module bridge. Test early with sample audio.
3. **Skill consolidation at scale:** O(n^2) comparison bounded to 1000 skills. Above that, switch to approximate NN.
4. **API cost variance:** Token estimates are approximate. Build cost monitoring into Settings.

## Success Criteria
1. First structured results streaming within 60 seconds of stopping recording
2. Full output per SLA table (1-3 min for typical sessions)
3. Knowledge base answers questions with cited source sessions
4. Recording works offline, processing queues automatically
5. Skill consolidation reduces duplicate skills over time

## Test Plan (TBD — See test plan artifact from /plan-eng-review)

## /autoplan Review Findings

### Phase Sequencing (Revised)

The original plan sequenced: Recording → Knowledge Layer → Skills Engine → Polish.
Both CEO and Eng reviews agree this is backwards. The Skills Engine is the moat and should ship earlier. Revised:

**Phase 0 (Week 1-2): Validation Gate**
- Record 5 real meetings/classes with phone voice recorder
- Manually write ideal structured outputs (ground truth)
- Spike: whisper.cpp on React Native feasibility (test the native bridge)
- Gate: prompts must produce acceptable output on real recordings before coding

**Phase 1 (Weeks 3-6): Ship Recording + Summaries**
- React Native scaffold, recording pipeline, API-based transcription
- API key management with "Try with sample" demo (no key required for first use)
- Structured summarization for all modes
- First App Store submission at end of Phase 1

**Phase 2 (Weeks 7-10): Skills Engine** (moved up from Phase 3)
- Skill extraction across all modes
- Skill consolidation with batched LLM merge (single prompt, not pairwise)
- Cost preview before consolidation runs

**Phase 3 (Weeks 11-14): Knowledge Layer** (moved back from Phase 2)
- Vector storage, RAG agent, course auto-classification
- Pure-JS vector search with latency instrumentation and migration trigger

**Phase 4 (Weeks 15-18): Polish & Analytics**
- Teacher analytics (text-based v1)
- SQLCipher encryption
- Background task architecture (or document foreground-only constraint)
- Error handling, storage management, CI/CD

### Critical Risks (Pre-Build)
1. **API key onboarding friction** → 90%+ drop-off risk. Mitigation: "Try with sample" no-key demo; consider absorbing API costs into one-time purchase price.
2. **whisper.cpp integration** → 4-6 week project, not a Phase 1 subtask. Mitigation: Phase 0 spike; use API-based transcription for Phase 1.
3. **Plan/design doc contradiction** → PLAN.md says whisper.cpp, design doc says API-based. Resolved: API-based for v1.
4. **App Store policy** → 500MB GGML model download may violate Apple policies. Mitigation: API-based transcription avoids this; research CoreML fallback.
5. **No background processing** → iOS limits background tasks to ~30s, but LLM calls take 3-5min. Mitigation: document foreground-only as v1 constraint or evaluate expo-task-manager.

## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | CEO | Phase 0 validation gate added | Mechanical | P6 (action) | Record real sessions before coding — prevents building blind | Skip validation, go straight to code |
| 2 | CEO | Phase sequencing inverted (Skills Engine before Knowledge Layer) | Taste | P1 (completeness) | Skills are the moat; platform vendors will catch up on transcription | Original sequencing (Knowledge before Skills) |
| 3 | CEO | API-based transcription for Phase 1, not whisper.cpp | Mechanical | P3 (pragmatic) | Avoids 4-6 week native bridge integration before shipping v1 | On-device whisper.cpp from day one |
| 4 | Eng | Batched LLM merge for skill consolidation | Mechanical | P3 (pragmatic) | Prevents $50+ silent API charges per consolidation run | Pairwise LLM comparisons |
| 5 | Eng | Test plan artifact required | Mechanical | P1 (completeness) | 16-week plan shipping to app stores without test plan is unacceptable | Deferred test planning |
| 6 | Eng | SQLCipher encryption added to Phase 4 | Mechanical | P5 (explicit) | Plaintext SQLite for confidential meetings is a security gap | Unencrypted local storage |
| 7 | CEO | "Try with sample" demo mode | Mechanical | P3 (pragmatic) | Bypasses 90%+ API key onboarding drop-off | Require API key on first launch |
| 8 | Eng | Streaming JSON accumulator pattern | Mechanical | P5 (explicit) | Handle incomplete LLM stream chunks gracefully | Show raw text on parse failure |
