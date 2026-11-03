const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const inventoryPath = path.join(root, 'modules', 'pcm-recorder', 'android', 'sherpa-native-inventory.json');
const indexTsPath = path.join(root, 'modules', 'pcm-recorder', 'src', 'index.ts');
const diaryServicePath = path.join(root, 'modules', 'pcm-recorder', 'android', 'src', 'main', 'java', 'expo', 'modules', 'pcmrecorder', 'DiaryForegroundService.kt');
const diaryModelsPath = path.join(root, 'modules', 'pcm-recorder', 'android', 'src', 'main', 'java', 'expo', 'modules', 'pcmrecorder', 'DiaryModels.kt');
const sherpaBridgePath = path.join(root, 'modules', 'pcm-recorder', 'android', 'src', 'main', 'java', 'expo', 'modules', 'pcmrecorder', 'SherpaBridge.kt');

function sha256Hex(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('native diary inventory exists and hashes match files', () => {
  assert.equal(fs.existsSync(inventoryPath), true, 'inventory file missing');
  const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
  assert.equal(inventory.version, 'v1.13.7');
  assert.ok(Array.isArray(inventory.files));
  assert.ok(inventory.files.length >= 3, 'expected AAR and two model files');

  for (const fileInfo of inventory.files) {
    assert.equal(fs.existsSync(fileInfo.outPath), true, `missing artifact: ${fileInfo.outPath}`);
    assert.equal(sha256Hex(fileInfo.outPath), fileInfo.hash, `sha256 mismatch: ${fileInfo.outPath}`);
  }
});

test('TypeScript contract includes required diary methods', () => {
  const text = fs.readFileSync(indexTsPath, 'utf8');
  const requiredSnippets = [
    'getDiaryStatus(): Promise<DiaryNativeStatus>;',
    'prepareDiaryModels(): Promise<void>;',
    'startDiary(): Promise<void>;',
    'stopDiary(): Promise<void>;',
    'pauseDiary(): Promise<void>;',
    'resumeDiary(): Promise<void>;',
    'identifySpeaker(filePath: string): Promise<SpeakerEvidence>;',
    'enrollSpeaker(filePath: string): Promise<void>;',
    'deleteSpeakerProfile(): Promise<void>;',
    'pauseRecording(): Promise<RecordingStatus>;',
    'resumeRecording(): Promise<RecordingStatus>;',
  ];
  for (const snippet of requiredSnippets) {
    assert.equal(text.includes(snippet), true, `missing snippet: ${snippet}`);
  }
});

test('manifest storage uses atomic synchronized recovery path', () => {
  const text = fs.readFileSync(diaryModelsPath, 'utf8');
  assert.match(text, /import\s+android\.util\.AtomicFile/);
  assert.match(text, /@Synchronized\s*\n\s*fun\s+save\(/);
  assert.match(text, /@Synchronized\s*\n\s*fun\s+recover\(/);
  assert.match(text, /writeManifestAtomic\(/);
  assert.match(text, /scanSegments\(/);
  assert.match(text, /isTrustedPath\(/);
});

test('diary capture loop blocks on pause and does not implicitly start on null intent', () => {
  const text = fs.readFileSync(diaryServicePath, 'utf8');
  assert.doesNotMatch(text, /ACTION_START,\s*null/);
  assert.match(text, /pauseLock\.wait\(\)/);
  assert.match(text, /pauseLock\.notifyAll\(\)/);
  assert.doesNotMatch(text, /Thread\.yield\(\)/);
  assert.match(text, /if \(n < 0\)/);
  assert.match(text, /audio_read_error_/);
});

test('speaker match is conservative and requires all usable windows matched', () => {
  const text = fs.readFileSync(sherpaBridgePath, 'utf8');
  assert.match(text, /MATCH_THRESHOLD\s*=\s*0\.80/);
  assert.match(text, /ENROLL_MIN_CONSISTENCY\s*=\s*0\.80/);
  assert.match(text, /allUsableMatched\s*=\s*matched\.size\s*==\s*usable\.size/);
  assert.match(text, /speaker\s*=\s*if \(enoughSpeech && remainderOkay && allUsableMatched\)/);
});
