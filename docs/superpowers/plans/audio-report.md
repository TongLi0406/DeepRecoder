# Audio Pipeline Implementation Report

Date: 2026-11-03
Status: DONE_WITH_CONCERNS

## Scope

Implemented only in approved paths:

- src/services/remoteStt.ts
- src/services/recording.ts
- src/services/whisper.ts
- src/services/recovery.ts
- test-data/audio.test.cjs
- docs/superpowers/plans/audio-report.md

No parent/shared/native module edits were made.

## Parent Integration Contracts

1. `transcribeRemote(audioUri, signal?, checkpointScope?)` is now implemented and compatible with `processingQueue` sequential remote-first pipeline.
2. `processingQueue` fallback contract remains unchanged: remote failure still falls back to whisper when available, not race mode.
3. `diary` calls to `transcribeRemote(segment.filePath)` remain compatible (optional args remain optional).
4. Recording API signatures are unchanged for screens and diary service:
   - `startRecording()`
   - `stopRecording(elapsedSeconds?)`
   - `pauseRecording()` / `resumeRecording()`
   - `cleanupRecording()`
   - `deleteFile(uri)`

## What Was Implemented

### 1) remoteStt

- Added required signature:
  - `transcribeRemote(audioUri: string, signal?: AbortSignal, checkpointScope?: string): Promise<string>`
- Added WAV parsing/validation for PCM 16k mono 16-bit using RIFF chunk parsing (no fixed 44-byte trust).
- Added chunked upload for long WAV with chunk boundaries aligned to sample bytes and bounded at <= 5 min / <= 10 MB.
- Implemented bounded file IO via `FileHandle.readBytes/writeBytes` (no whole-file base64/arrayBuffer load path).
- Added per-chunk persistent checkpointing via existing storage checkpoint APIs keyed by scope + model + full file identity + chunk offset/size.
- Retry behavior:
  - one bounded retry for retryable network/timeout errors
  - no retry on abort
- External abort now maps to real upload cancellation and propagates as abort error.
- Sanitized errors (no response bodies or source audio URIs surfaced).
- Ensured every temp chunk file is deleted in `finally`.

### 2) recording

- Android-first PCM enforcement:
  - requires native `PcmRecorder` on Android
  - if unavailable, throws explicit custom-development-build guidance
  - no Android compressed fallback path
- Permission flow:
  - checks current permission before requesting
  - throws on denied permission
- Diary guard:
  - blocks normal recording start while diary capture is active
- Pause/resume correctness:
  - native PCM uses `pauseRecording/resumeRecording`
  - native duration comes from recorder status, not JS elapsed timer
- iOS fallback retained with persistent document storage setup.
- Web behavior tightened:
  - microphone denial no longer silently falls into simulation
  - optional simulation requires explicit runtime opt-in flag
- `deleteFile`:
  - revokes web blob URIs
  - native deletion throws on real filesystem failure, ignores non-existent files
- Stop path preserves active recorder state unless stop succeeds.

### 3) whisper

- Added reusable canonical helpers:
  - `buildPcm16MonoWavHeader(dataBytes)` now allocates 44-byte header only
  - RIFF/WAV parser for PCM 16k mono validation
- Chunked whisper path now:
  - reads/writes bounded blocks
  - tracks active chunk task and cancels with `task.stop()` on abort
  - avoids deleting temp file before active task settle
  - always cleans temp files on success/failure
- `isWhisperAvailable()` now checks platform/model readiness more truthfully and reflects initialization failure state.

### 4) recovery

- Interrupted phases (`transcribing/summarizing/indexing/extracting`) are normalized to `queued` (no reset to `recording`).
- Removed forced 24h recording abandonment transition.
- `savePartialResults` now persists serialized partial data before phase update.
- `isCreditExhausted` no longer treats generic `429/rate_limit` as exhausted credit.
- Disk-space check failure now returns non-OK warning state instead of silently OK with unknown 0 MB.
- Orphan cleanup now avoids deleting files referenced by existing sessions.

## Tests Added

New file: `test-data/audio.test.cjs`

Coverage includes:

1. Long WAV chunking and ordered transcript join.
2. Checkpoint resume behavior for partial completion.
3. External abort propagation to active upload.
4. WAV header fixed-size (44 bytes) contract.
5. PCM permission/init + native pause/resume + native duration source.
6. Recovery phase normalization and 429 credit classification contract.

## Verification

1. `node --test test-data/audio.test.cjs`
   - pass: 6
   - fail: 0
2. `node --test test-data/pipeline.test.cjs`
   - pass: 11
   - fail: 0
3. `npx tsc --noEmit --pretty false`
   - workspace has unrelated existing diagnostics
   - touched files (`remoteStt.ts`, `recording.ts`, `whisper.ts`, `recovery.ts`) report no diagnostics

## Remaining Gates / Concerns

1. Java/Android SDK native build verification is still pending by environment constraint.
2. Full-project TypeScript gate is not green due to unrelated pre-existing diagnostics outside touched scope.
