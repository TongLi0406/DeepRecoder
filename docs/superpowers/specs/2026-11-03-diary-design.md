# Bounded processing and Android diary

## Approved direction

Android first; retain the existing meeting and classroom modes. Audio may be sent
to the configured transcription provider after explicit consent. Speaker templates
and speaker inference remain on-device. No server infrastructure is added.

## Context and output limits

All LLM calls reserve prompt, output, and safety space against a configurable
model context limit. Use a conservative UTF-8 byte upper estimate when an exact
tokenizer is unavailable. Never silently truncate transcript text. Summarization
maps bounded transcript chunks to compact factual notes, then recursively reduces
bounded groups before producing the existing structured output. Every reduction
must shrink; nonshrinking output fails explicitly rather than looping. Preserve
the complete transcript locally, not in generated JSON. Skill extraction uses
bounded chunks. Retrieval context has a budget too. Detect provider output-limit
responses, reject thinking-only output, support cancellation and request timeout.

## Durable processing

Keep stage outputs and chunk checkpoints in SQLite. Resume all pending sessions,
not only the first. Make indexing and extracted skills idempotent per session.
Cancellation aborts active requests and does not advance to the next stage. Do not
turn interrupted processing back into an active recording. Capture files belong
in persistent application storage. Recording duration derives from captured PCM,
not a JavaScript screen timer.

## Android diary capture

A microphone foreground service owns capture independently of React components.
Start only from a visible, consented user action. Show a persistent notification
with stop, and provide pause/resume in the app. Use 16 kHz mono PCM, bounded
buffers, a proven speech-activity detector, and bounded speech files. Store start
and end timestamps and timezone offsets per file. A native manifest survives JS
suspension and process death; recovery repairs unfinished WAV files. Never
auto-restart the microphone after force-stop, reboot, or permission loss.

Speech recognition, speaker inference, and daily generation run serially outside
the capture thread. Foreground events trigger best-effort processing; foreground
re-entry drains persisted files. The app displays pending work honestly. It does
not promise continuous live text while JS is suspended or exact midnight execution.
Pause on unavailable input, low storage, and thermal/battery safety conditions.
Do not sample intermittently and claim uninterrupted capture. Ordinary recording
and diary capture cannot own the microphone simultaneously.

## Identity and privacy

Use sherpa-onnx speaker embeddings and its VAD with pinned artifacts and model
versions. Enrollment requires clean solo speech and multiple consistent samples.
Store the enrolled vector in Android encrypted storage. Diarization and short
window matching retain timestamps and similarity. A match is probabilistic, not a
verified identity: unknown, mixed, short, or inconsistent windows stay unknown.
Explicit user confirmation is distinct from automatic matching. No LLM inference
of identity, emotion, or personal ownership from ambient text. Re-enrollment and
deletion remove old templates. The diary remains usable with unknown speakers if
the recognition engine is unavailable, but must clearly expose that limitation.

Diary is disabled by default. Obtain recording/cloud-processing consent and remind
the user to obtain consent from participants. Store recordings only in private
application directories. Add retention and storage caps, pause, and delete controls.
Never automatically delete unprocessed audio to satisfy retention. A user delete
cancels processing before removing audio, transcripts, summaries, and templates.

## Daily output

Persist segment transcript, identity evidence, processing status, and errors.
Group by the captured local calendar date, not UTC conversion at generation time.
Generate timeline events, discussion topics, explicit commitments, and unresolved
items with validated source segment IDs. Only confirmed/strongly matched user
speech can support first-person attribution; ambiguous speech uses neutral prose.
Late transcripts invalidate the day's revision and can regenerate it. Empty days
do not fabricate entries. Audio and summaries remain separate so evidence survives
compression. Cross-midnight files split at the date boundary.

## Verification gates

Runnable tests cover long CJK text and Unicode boundaries, recursive reduction,
provider truncation, cancellation, checkpoint reuse, queue recovery, local dates,
unknown identity and source validation. Typecheck and web bundle are software gates.
Android compilation is a separate gate requiring Java/SDK. Physical-device gates
cover locked-screen capture, notification stop, calls/headset interruption,
process death, enrollment impostors/noise/overlap, disk limits, and measured battery
drain. Hardware accuracy and power savings cannot be certified by static checks.
