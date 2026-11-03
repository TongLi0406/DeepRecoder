# Diary App Report (2026-11-03)

Status: DONE_WITH_REVIEW_FIXES

## Reviewer findings fixed (Critical/Important)

- Consent revocation is now lifecycle-atomic: consent is persisted to false first, then active capture/workers are canceled and drained before further diary processing can continue.
- Diary processing and daily generation now use cancellation-aware guards with consent/lifecycle checks before and after async boundaries, including remote STT and bounded-note reduction calls.
- Daily generation now uses marker-bounded provenance (`[[SRC:segment-id]]`) and rejects outputs that invent or omit required source IDs.
- Purge and retention flows are serialized by an exclusive lifecycle mutation gate, drain workers first, clean diary checkpoint namespaces, and avoid delete races with capture start.
- Segment deletion and identity-confirmation paths now invalidate stale derived daily content (`dirty` + cleared derived payload) before showing new truth.
- Voice profile deletion and re-enrollment now invalidate historical auto identity evidence (`speakerAuto/similarity/profileRevision/windows`) while preserving manual confirmation fields.
- Raw-only purge semantics are now explicit via `audioDeleted` metadata, rather than silently claiming derived data was removed.

## Scope implemented

- Added Android-first Diary feature wiring with explicit privacy consent gating.
- Added a dedicated Diary tab UI with:
  - consent disclosure and explicit grant/revoke actions,
  - start/stop/pause/resume capture controls,
  - queue status (pending/failed/retryable/done),
  - manual daily generate/update,
  - retention policy controls (1/7/30 days),
  - purge raw audio only / purge all derived data (confirmed, destructive dialogs),
  - local voice enrollment (15-30s), cancel, profile delete/re-enroll,
  - per-segment transcript visibility and source IDs,
  - manual identity confirmation per segment with explicit confirmation dialogs.
- Added persistent `diary.db` storage with promise-safe initialization and durable states:
  - idempotent native segment import,
  - pending/transcribing/done/failed segment lifecycle,
  - stale worker recovery for transcribing/generating states,
  - daily diary versioning and dirty marking on late transcript,
  - source ID validation against submitted done segments of same localDate,
  - retention planning that reports unprocessed backlog and requires explicit force purge.
- Added diary orchestration service:
  - consent-gated import/process pipeline,
  - conservative speaker handling (`unknown` default; auto match treated probabilistically),
  - no identity fabrication in prompts,
  - bounded per-segment factual note compaction,
  - hierarchical bounded daily consolidation,
  - source validation before save,
  - app foreground trigger for import/processing only when consent exists.

## Files changed

- src/types/diary.ts
- src/services/diaryStorage.ts
- src/services/diary.ts
- src/screens/DiaryScreen.tsx
- src/navigation/AppNavigator.tsx
- App.tsx
- test-data/diary.test.cjs
- docs/superpowers/plans/diary-app-report.md

## Tests run

1) `node --test test-data/diary.test.cjs test-data/audio.test.cjs test-data/pipeline.test.cjs`
- Output summary: 28 tests passed, 0 failed.

2) Targeted TypeScript diagnostics on edited files
- `src/services/diary.ts`: no errors
- `src/services/diaryStorage.ts`: no errors
- `src/types/diary.ts`: no errors
- `src/screens/DiaryScreen.tsx`: no errors
- `test-data/diary.test.cjs`: no errors

## Privacy and safety checks implemented

- Capture start requires persisted consent.
- Consent copy includes participant authorization, local law reminder, and visible ongoing notification requirement.
- Revocation blocks new processing/generation enrollment while cancellation and drain complete.
- Web/iOS explicitly marked unavailable for Android diary capture (no fake background behavior).
- Active capture blocks destructive deletion paths.
- Temporary local enrollment audio is deleted on success/failure/cancel path.
- Manual identity confirmation applies only to selected segment and requires explicit confirmation action.
- Revocation cannot retract data that was already uploaded to the transcription provider before cancellation took effect; UI/legal copy should communicate that boundary.

## Integration assumptions

- Native `PcmRecorder` diary APIs are available at runtime as documented by parent contract.
- Remote STT cancellation and checkpoint scoping are relied on (`transcribeRemote(audioUri, signal, checkpointScope)`).
- Existing `callLLM` guard enforces request bounds; diary prompts rely on that guard.

## Concerns / unverified limits

- Android compile and physical-device validation were not run here (Java/SDK/hardware unavailable).
- Foreground service correctness, lock-screen behavior, thermal/battery throttling behavior, and notification action behavior remain device-gated.
- Speaker identity calibration remains probabilistic; app labels avoid claiming verified identity.
