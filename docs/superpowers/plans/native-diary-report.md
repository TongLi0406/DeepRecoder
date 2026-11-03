# Native Diary Task3 Report

Status: DONE_WITH_BLOCKED_ANDROID_COMPILE_GATE
Date: 2026-11-03

## Scope Confirmation

- Implemented only within `modules/pcm-recorder/**`, `test-data/native-diary.test.cjs`, and this report.
- Did not modify `src/**`, `App.tsx`, `package.json` (workspace root), `app.json`, or `test-data/pipeline.test.cjs`.

## Implemented

1. Native foreground diary microphone service outside React lifetime.
2. 16kHz mono PCM16 WAV writing in private persistent storage.
3. Persistent diary manifest with:
   - segment metadata (`id`, timestamps, local date, UTC offset, duration)
   - active/paused/error status
   - `AtomicFile` atomic write and synchronized read-modify-write transactions
   - recovery of unfinished WAV header and manifest state after process death, appending recovered current segment instead of dropping it
   - orphan segment scan when manifest is missing/corrupted.
4. VAD-based segmentation using sherpa-onnx Silero model via runtime bridge.
5. Bounded behavior:
   - prebuffer and tail behavior
   - bounded segment duration
   - disk floor (500MB), diary cap (500MB)
   - low battery stop (<=15% when not charging)
   - severe thermal stop
6. Notification-backed foreground service with STOP action and `START_NOT_STICKY`.
7. Ordinary `PcmRecorder` and diary capture mutual exclusion.
8. Ordinary recorder fixes:
   - stop ordering to avoid blocking read-loop
   - final WAV header recovery on destroy
   - persistent directory (`filesDir/pcm-recordings`) instead of cache
   - `pauseRecording`/`resumeRecording`
   - duration computed from captured sample count
   - pause wait/notify (no busy-yield) and negative AudioRecord read fatal handling (except transient dead-object).
9. Speaker profile flow (local only):
   - enrollment from 15-30s audio
   - strict multi-window consistency checks for clean-speech enrollment
   - AES/GCM encryption with Android Keystore
   - identify with 3-second windows and per-window evidence
   - conservative unknown unless all usable windows match with enough speech and acceptable remainder
   - trusted input path and file size cap checks, nonfinite/dimension mismatch rejection.
10. Parent API contract retained in `modules/pcm-recorder/src/index.ts`:
    - `getDiaryStatus`, `prepareDiaryModels`, `startDiary`, `stopDiary`, `pauseDiary`, `resumeDiary`, `listDiarySegments`, `deleteDiarySegment`, `identifySpeaker`, `enrollSpeaker`, `deleteSpeakerProfile`
    - plus `pauseRecording` and `resumeRecording`.

## Sherpa Artifacts (Pinned)

- AAR: `sherpa-onnx-1.13.7.aar`
  - URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-1.13.7.aar`
  - SHA256: `c4ef49e309f24fcee5c106b8a279481aaecaabb078cd37b2cd6e9a62cc8a73c8`
- Silero VAD model:
  - URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx`
  - SHA256: `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`
- Speaker model:
  - URL: `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx`
  - SHA256: `1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b`

Provision script:
- `modules/pcm-recorder/android/scripts/setup-native-diary.js`

Inventory output:
- `modules/pcm-recorder/android/sherpa-native-inventory.json`

## Touched Files

- `modules/pcm-recorder/android/build.gradle`
- `modules/pcm-recorder/android/src/main/java/expo/modules/pcmrecorder/PcmRecorderModule.kt`
- `modules/pcm-recorder/android/src/main/java/expo/modules/pcmrecorder/DiaryModels.kt`
- `modules/pcm-recorder/android/src/main/java/expo/modules/pcmrecorder/SherpaBridge.kt`
- `modules/pcm-recorder/android/src/main/java/expo/modules/pcmrecorder/DiaryForegroundService.kt`
- `test-data/native-diary.test.cjs`

## Validation Results

1. Focused Node test (behavior-oriented in owned scope):
   - Command: `node --test test-data/native-diary.test.cjs`
   - Result: PASS (5/5)
   - Covers inventory hash pinning, TS contract retention, atomic manifest/recovery guardrails, pause/wait-notify and non-implicit start guard, conservative identity policy guards.
2. IDE diagnostics on changed files:
   - Result: no errors found on all owned changed files.
3. TypeScript whole-project check:
   - Existing unrelated errors present in app screens/services outside scope.
4. Native compile/toolchain gate:
   - `where java/javac/gradle/adb` all not found in this host session.
   - Common Android SDK and Android Studio JBR paths were probed and not present.
   - `modules/pcm-recorder/android/gradlew.bat` missing.
   - Result: compile could not be executed in current environment.

## Unresolved / Environment Requirements

1. Android compile gate remains blocked by missing Java/Gradle/SDK/adb toolchain visibility in this environment.
2. Device-level behavior (notification stop, lock-screen capture, calls/headset interruption, thermal and battery reactions) still requires physical Android validation.
3. Runtime `modelsReady` still depends on provisioned model files and host build packaging.
4. This pass does not claim functional correctness of end-to-end native capture/STT/identity on device; it claims code-level fixes plus executable local guard tests only.
