const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  module._compile(code, filename);
};

function loadService(relativePath, mocks = {}) {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, relativePath);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => name in mocks ? mocks[name] : Module.prototype.require.call(loaded, name);
  require.extensions['.ts'](loaded, filename);
  return loaded.exports;
}

function makeSqliteAdapter() {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  return {
    close: () => database.close(),
    adapter: {
      execAsync: async sql => database.exec(sql),
      runAsync: async (sql, ...args) => database.prepare(sql).run(...args),
      getFirstAsync: async (sql, ...args) => database.prepare(sql).get(...args),
      getAllAsync: async (sql, ...args) => database.prepare(sql).all(...args),
    },
  };
}

test('native segment import is idempotent and retains localDate grouping', async () => {
  const sqlite = makeSqliteAdapter();
  const storage = loadService('../src/services/diaryStorage.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-sqlite': { openDatabaseAsync: async () => sqlite.adapter },
  });

  await storage.initDiaryStorage();
  const segments = [{
    id: 'seg-1',
    filePath: '/tmp/seg-1.wav',
    startTime: '2026-11-03T10:00:00.000+08:00',
    endTime: '2026-11-03T10:01:00.000+08:00',
    localDate: '2026-11-03',
    utcOffsetMinutes: 480,
    durationMs: 60000,
  }];

  const first = await storage.importNativeDiarySegments(segments);
  const second = await storage.importNativeDiarySegments(segments);
  const list = await storage.listDiarySegmentsByDate('2026-11-03');

  assert.equal(first.inserted, 1);
  assert.equal(second.inserted, 0);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'seg-1');
  sqlite.close();
});

test('stale worker recovery requeues transcribing segments and generating days', async () => {
  const sqlite = makeSqliteAdapter();
  const storage = loadService('../src/services/diaryStorage.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-sqlite': { openDatabaseAsync: async () => sqlite.adapter },
  });

  await storage.initDiaryStorage();
  await storage.importNativeDiarySegments([{
    id: 'seg-2', filePath: '/tmp/seg-2.wav',
    startTime: '2026-11-03T10:00:00.000+08:00', endTime: '2026-11-03T10:01:00.000+08:00',
    localDate: '2026-11-03', utcOffsetMinutes: 480, durationMs: 60000,
  }]);
  await storage.markSegmentState('seg-2', 'transcribing');
  await storage.saveDailyDiaryDraft('2026-11-03', { state: 'generating', notes: '', sourceSegmentIds: ['seg-2'] });

  const recovered = await storage.recoverDiaryStaleStates();
  const segment = await storage.getDiarySegment('seg-2');
  const day = await storage.getDailyDiary('2026-11-03');

  assert.equal(recovered.requeuedSegments, 1);
  assert.equal(recovered.recoveredDays, 1);
  assert.equal(segment.state, 'pending');
  assert.equal(day.state, 'dirty');
  sqlite.close();
});

test('daily diary rejects source IDs that are not part of that local date', async () => {
  const sqlite = makeSqliteAdapter();
  const storage = loadService('../src/services/diaryStorage.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-sqlite': { openDatabaseAsync: async () => sqlite.adapter },
  });

  await storage.initDiaryStorage();
  await storage.importNativeDiarySegments([{
    id: 'seg-3', filePath: '/tmp/seg-3.wav',
    startTime: '2026-11-03T09:00:00.000+08:00', endTime: '2026-11-03T09:01:00.000+08:00',
    localDate: '2026-11-03', utcOffsetMinutes: 480, durationMs: 60000,
  }]);
  await storage.markSegmentResult('seg-3', {
    transcript: 'hello', factualNotes: '[S:seg-3] hello',
    speakerAuto: 'unknown', speakerSimilarity: null, profileRevision: null, windows: [],
  });

  await assert.rejects(
    storage.saveDailyDiary('2026-11-03', { notes: 'x', sourceSegmentIds: ['seg-x'], content: { timeline: [] } }),
    /source/i,
  );

  await storage.saveDailyDiary('2026-11-03', {
    notes: 'x',
    sourceSegmentIds: ['seg-3'],
    content: { timeline: [], topics: [], commitments: [], unresolved: [], caveat: 'Sources are references, not proof.' },
  });

  const day = await storage.getDailyDiary('2026-11-03');
  assert.equal(day.state, 'ready');
  assert.deepEqual(day.sourceSegmentIds, ['seg-3']);
  sqlite.close();
});

test('retention planning reports unprocessed backlog instead of silently deleting it', async () => {
  const sqlite = makeSqliteAdapter();
  const storage = loadService('../src/services/diaryStorage.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-sqlite': { openDatabaseAsync: async () => sqlite.adapter },
  });

  await storage.initDiaryStorage();
  await storage.setDiaryRetentionDays(1);
  await storage.importNativeDiarySegments([
    {
      id: 'seg-done', filePath: '/tmp/seg-done.wav',
      startTime: '2026-11-01T09:00:00.000+08:00', endTime: '2026-11-01T09:01:00.000+08:00',
      localDate: '2026-11-01', utcOffsetMinutes: 480, durationMs: 60000,
    },
    {
      id: 'seg-pending', filePath: '/tmp/seg-pending.wav',
      startTime: '2026-11-01T10:00:00.000+08:00', endTime: '2026-11-01T10:01:00.000+08:00',
      localDate: '2026-11-01', utcOffsetMinutes: 480, durationMs: 60000,
    },
  ]);
  await storage.markSegmentResult('seg-done', {
    transcript: 'done', factualNotes: '[S:seg-done] done',
    speakerAuto: 'unknown', speakerSimilarity: null, profileRevision: null, windows: [],
  });

  const plan = await storage.planRetentionCleanup('2026-11-05T00:00:00.000Z');
  assert.ok(plan.deletableSegmentIds.includes('seg-done'));
  assert.ok(plan.blockedUnprocessedSegmentIds.includes('seg-pending'));
  sqlite.close();
});

test('revoking consent cancels in-flight diary queue processing and prevents late writes', async () => {
  let consentGranted = true;
  const calls = {
    setDiaryConsent: [],
    markSegmentResult: 0,
    markSegmentState: 0,
  };

  const service = loadService('../src/services/diary.ts', {
    'react-native': { Platform: { OS: 'web' } },
    './api': { callLLM: async () => '{"summaryNeutral":"","timeline":[],"topics":[],"commitments":[],"unresolved":[],"caveat":"Sources are references, not proof."}' },
    './summarization': {
      compactTranscript: async (_text, _apiKey, options = {}) => {
        if (options.signal?.aborted) throw new Error('aborted');
        return 'fact';
      },
    },
    './remoteStt': {
      transcribeRemote: async (_audioUri, signal) => {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve('late transcript should not be saved'), 80);
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('Remote STT aborted'));
            }, { once: true });
          }
        });
      },
    },
    './llmContext': {
      compactText: async text => text,
      splitText: text => [text],
      textBytes: text => Buffer.byteLength(String(text), 'utf8'),
      checkAbort: signal => {
        if (signal?.aborted) throw new Error('aborted');
      },
    },
    './recording': {
      startRecording: async () => ({ simulated: true }),
      stopRecording: async () => ({ uri: '', durationMs: 0 }),
      cleanupRecording: async () => {},
      isRecordingActive: () => false,
      deleteFile: async () => {},
    },
    './storage': { deleteProcessingCheckpoints: async () => {} },
    './diaryStorage': {
      initDiaryStorage: async () => {},
      recoverDiaryStaleStates: async () => ({ requeuedSegments: 0, recoveredDays: 0 }),
      getDiarySettings: async () => ({ consentGranted, retentionDays: 7 }),
      setDiaryConsent: async value => { calls.setDiaryConsent.push(value); consentGranted = value; },
      setDiaryRetentionDays: async () => {},
      getDiaryQueueStats: async () => ({ pending: 0, transcribing: 0, failed: 0, done: 0, retryableFailed: 0 }),
      importNativeDiarySegments: async () => ({ inserted: 0, updated: 0, unchanged: 0 }),
      listDailyDiaryEntries: async () => [],
      listDiarySegmentsByDate: async () => [],
      listPendingDiarySegments: async () => ([{
        id: 'seg-cancel',
        filePath: '/tmp/seg-cancel.wav',
        startTime: '2026-11-03T09:00:00.000+08:00',
        endTime: '2026-11-03T09:01:00.000+08:00',
        localDate: '2026-11-03',
        utcOffsetMinutes: 480,
        durationMs: 60000,
        state: 'pending',
        transcript: '',
        factualNotes: '',
        speakerAuto: 'unknown',
        speakerSimilarity: null,
        profileRevision: null,
        speakerWindows: [],
        manualIdentity: 'none',
        manualIdentityNote: '',
        lastError: '',
        retryCount: 0,
        updatedAt: '2026-11-03T09:00:00.000Z',
      }]),
      markSegmentState: async () => { calls.markSegmentState += 1; },
      markSegmentResult: async () => { calls.markSegmentResult += 1; },
      markDayDirty: async () => {},
      saveDailyDiaryDraft: async () => {},
      saveDailyDiary: async () => {},
      markDailyDiaryFailed: async () => {},
      getDailyDiary: async () => null,
      getDiarySegment: async () => null,
      deleteSegment: async () => {},
      deleteSegmentsByIds: async () => {},
      setManualSegmentIdentity: async () => {},
      clearAllDiaryData: async () => {},
      planRetentionCleanup: async () => ({ cutoffLocalDate: '2026-11-01', deletableSegmentIds: [], blockedUnprocessedSegmentIds: [] }),
    },
  });

  const processing = service.processDiaryQueue(1);
  await new Promise(resolve => setTimeout(resolve, 10));
  await service.setDiaryConsentGranted(false);
  const result = await processing;

  assert.equal(calls.setDiaryConsent[0], false);
  assert.equal(calls.markSegmentResult, 0);
  assert.equal(result.processed, 0);
  assert.ok(result.failed >= 0);
});

test('confirming segment identity marks day dirty and clears stale derived diary', async () => {
  const events = [];
  const service = loadService('../src/services/diary.ts', {
    'react-native': { Platform: { OS: 'web' } },
    './api': { callLLM: async () => '{}' },
    './summarization': { compactTranscript: async () => '' },
    './remoteStt': { transcribeRemote: async () => '' },
    './llmContext': {
      compactText: async text => text,
      splitText: text => [text],
      textBytes: text => Buffer.byteLength(String(text), 'utf8'),
      checkAbort: signal => {
        if (signal?.aborted) throw new Error('aborted');
      },
    },
    './recording': {
      startRecording: async () => ({ simulated: true }),
      stopRecording: async () => ({ uri: '', durationMs: 0 }),
      cleanupRecording: async () => {},
      isRecordingActive: () => false,
      deleteFile: async () => {},
    },
    './storage': { deleteProcessingCheckpoints: async () => {} },
    './diaryStorage': {
      initDiaryStorage: async () => {},
      recoverDiaryStaleStates: async () => ({ requeuedSegments: 0, recoveredDays: 0 }),
      getDiarySettings: async () => ({ consentGranted: true, retentionDays: 7 }),
      setDiaryConsent: async () => {},
      setDiaryRetentionDays: async () => {},
      getDiaryQueueStats: async () => ({ pending: 0, transcribing: 0, failed: 0, done: 0, retryableFailed: 0 }),
      importNativeDiarySegments: async () => ({ inserted: 0, updated: 0, unchanged: 0 }),
      listDailyDiaryEntries: async () => [],
      listDiarySegmentsByDate: async () => [],
      listPendingDiarySegments: async () => [],
      markSegmentState: async () => {},
      markSegmentResult: async () => {},
      markDayDirty: async (_date, _reason, clearDerived) => { events.push(clearDerived === true); },
      saveDailyDiaryDraft: async () => {},
      saveDailyDiary: async () => {},
      markDailyDiaryFailed: async () => {},
      getDailyDiary: async () => null,
      getDiarySegment: async () => ({ localDate: '2026-11-03' }),
      deleteSegment: async () => {},
      deleteSegmentsByIds: async () => {},
      setManualSegmentIdentity: async () => {},
      clearAllDiaryData: async () => {},
      planRetentionCleanup: async () => ({ cutoffLocalDate: '2026-11-01', deletableSegmentIds: [], blockedUnprocessedSegmentIds: [] }),
    },
  });

  await service.confirmSegmentIdentity('seg-identity', 'confirmed_self', 'manual');
  assert.equal(events.length, 1);
  assert.equal(events[0], true);
});

function loadDailyGeneration(callLLM, segments) {
  let saved;
  return loadService('../src/services/diary.ts', {
    'react-native': { Platform: { OS: 'web' } },
    './api': {
      getModelConfig: async () => ({ contextLimit: 8192 }),
      callLLM,
    },
    './summarization': { compactTranscript: async () => '' },
    './remoteStt': { transcribeRemote: async () => '' },
    './llmContext': require('../src/services/llmContext.ts'),
    './recording': {
      startRecording: async () => ({ simulated: true }),
      stopRecording: async () => ({ uri: '', durationMs: 0 }),
      cleanupRecording: async () => {},
      isRecordingActive: () => false,
      deleteFile: async () => {},
    },
    './storage': { deleteProcessingCheckpoints: async () => {} },
    './diaryStorage': {
      initDiaryStorage: async () => {},
      recoverDiaryStaleStates: async () => ({ requeuedSegments: 0, recoveredDays: 0 }),
      getDiarySettings: async () => ({ consentGranted: true, retentionDays: 7 }),
      setDiaryConsent: async () => {},
      setDiaryRetentionDays: async () => {},
      getDiaryQueueStats: async () => ({ pending: 0, transcribing: 0, failed: 0, done: 0, retryableFailed: 0 }),
      importNativeDiarySegments: async () => ({ inserted: 0, updated: 0, unchanged: 0 }),
      listDailyDiaryEntries: async () => [],
      listDiarySegmentsByDate: async () => segments ?? ([{
        id: 'seg-ok',
        filePath: '/tmp/seg-ok.wav',
        startTime: '2026-11-03T09:00:00.000+08:00',
        endTime: '2026-11-03T09:01:00.000+08:00',
        localDate: '2026-11-03',
        utcOffsetMinutes: 480,
        durationMs: 60000,
        state: 'done',
        transcript: 'hello',
        factualNotes: 'fact',
        speakerAuto: 'unknown',
        speakerSimilarity: null,
        profileRevision: null,
        speakerWindows: [],
        manualIdentity: 'none',
        manualIdentityNote: '',
        lastError: '',
        retryCount: 0,
        updatedAt: '2026-11-03T09:00:00.000Z',
      }]),
      listPendingDiarySegments: async () => [],
      markSegmentState: async () => {},
      markSegmentResult: async () => {},
      markDayDirty: async () => {},
      saveDailyDiaryDraft: async () => {},
      saveDailyDiary: async (_date, result) => { saved = { ...result, state: 'ready' }; },
      markDailyDiaryFailed: async () => {},
      getDailyDiary: async () => saved ?? null,
      getDiarySegment: async () => null,
      deleteSegment: async () => {},
      deleteSegmentsByIds: async () => {},
      setManualSegmentIdentity: async () => {},
      clearAllDiaryData: async () => {},
      planRetentionCleanup: async () => ({ cutoffLocalDate: '2026-11-01', deletableSegmentIds: [], blockedUnprocessedSegmentIds: [] }),
    },
  });
}

function sourcedDiary(sourceId) {
  return JSON.stringify({
    summaryNeutral: 'Discussed plans.',
    timeline: [{ timeHint: '', event: 'Discussed plans.', sourceSegmentIds: [sourceId] }],
    topics: [], commitments: [], unresolved: [],
    caveat: 'Sources are references, not proof.',
  });
}

test('daily generation fails when final output uses sources missing from bounded markers', async () => {
  const service = loadDailyGeneration(async () => sourcedDiary('seg-missing'));

  await assert.rejects(
    service.generateDailyDiary('2026-11-03'),
    /unknown source|source/i,
  );
});

test('long daily generation bounds every reduction and final request to an 8K context', async () => {
  const context = require('../src/services/llmContext.ts');
  const segments = Array.from({ length: 24 }, (_, index) => ({
    id: `seg-${index}`, state: 'done', manualIdentity: 'none', speakerAuto: 'unknown',
    factualNotes: '讨论计划。'.repeat(400),
  }));
  let reductions = 0;
  let finalCalls = 0;
  const service = loadDailyGeneration(async (system, prompt, _key, output) => {
    context.assertRequestBudget(system, prompt, output, 8192);
    const sourceIds = [...prompt.matchAll(/\[\[SRC:([A-Za-z0-9._-]+)\]\]/g)].map(match => match[1]);
    if (system.includes('Generate a daily diary')) {
      finalCalls += 1;
      return sourcedDiary(sourceIds[0]);
    }
    reductions += 1;
    return sourceIds.length ? `[[SRC:${sourceIds[0]}]] Discussed plans.` : 'Discussed plans.';
  }, segments);

  const result = await service.generateDailyDiary('2026-11-03');
  assert.equal(result.state, 'ready');
  assert.ok(reductions > segments.length);
  assert.equal(finalCalls, 1);
  assert.ok(result.sourceSegmentIds.length > 0);
  assert.ok(result.sourceSegmentIds.every(id => segments.some(segment => segment.id === id)));
});

test('daily generation rejects forged source markers in intermediate reductions', async () => {
  const segments = Array.from({ length: 6 }, (_, index) => ({
    id: `seg-${index}`, state: 'done', manualIdentity: 'none', speakerAuto: 'unknown',
    factualNotes: '讨论计划。'.repeat(120),
  }));
  let finalCalls = 0;
  const service = loadDailyGeneration(async system => {
    if (system.includes('Generate a daily diary')) finalCalls += 1;
    return '[[SRC:forged]] Discussed plans.';
  }, segments);

  await assert.rejects(service.generateDailyDiary('2026-11-03'), /out-of-scope source/);
  assert.equal(finalCalls, 0);
});

test('diary screen displays generated content and sources but not stale daily output', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const day = {
    localDate: '2026-11-03', version: 1, state: 'ready',
    content: {
      summaryNeutral: 'A productive discussion.',
      timeline: [{ timeHint: '09:00', event: 'Discussed plans.', sourceSegmentIds: ['seg-ui'] }],
      topics: [{ topic: 'Schedule', details: 'Delivery next week.', sourceSegmentIds: ['seg-ui'] }],
      commitments: [{ item: 'Send draft', owner: 'Participant', due: 'Friday', sourceSegmentIds: ['seg-ui'] }],
      unresolved: [{ item: 'Confirm venue', sourceSegmentIds: ['seg-ui'] }],
      caveat: 'Sources are references, not proof.',
    },
  };
  const render = () => {
    const states = [null, [day], day.localDate, [], false, '', false, false];
    let stateIndex = 0;
    const host = ({ children }) => React.createElement('div', null, children);
    const screen = loadService('../src/screens/DiaryScreen.tsx', {
      react: { ...React, useState: () => [states[stateIndex++], () => {}] },
      'react-native': {
        Platform: { OS: 'web' }, Alert: {}, StyleSheet: { create: styles => styles },
        Pressable: host, ScrollView: host, Text: host, View: host,
      },
      '../services/diary': {},
      '@react-navigation/native': { useFocusEffect: () => {}, useNavigation: () => ({ navigate() {} }) },
      'lucide-react-native': new Proxy({}, { get: () => host }),
      '../ui': { colors: {}, fonts: {}, uiStyles: {}, ScreenHeader: host, PageEntrance: host, IconButton: host, RecordingPulse: host },
    });
    return renderToStaticMarkup(React.createElement(screen.default));
  };
  const html = render();
  assert.ok(!html.includes('Prepare Models'), 'native setup controls must not clutter the Web diary');
  assert.ok(!html.includes('Start Enrollment'), 'enrollment belongs to settings, not the reading view');
  assert.ok(html.indexOf('Daily Diaries') < html.indexOf('Diary Settings'), 'daily content must precede configuration');
  for (const text of ['A productive discussion.', 'Discussed plans.', 'Delivery next week.', 'Send draft', 'Friday', 'Confirm venue', 'seg-ui']) {
    assert.ok(html.includes(text), `missing generated content: ${text}`);
  }
  day.state = 'dirty';
  const stale = render();
  assert.ok(!stale.includes('A productive discussion.'));
  assert.ok(!stale.includes('Discussed plans.'));
});