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

const contextPath = path.resolve(__dirname, '../src/services/llmContext.ts');
const context = fs.existsSync(contextPath) ? require(contextPath) : {};

test('main navigation has four task destinations and no settings tab', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const host = ({ children }) => React.createElement('div', null, children);
  const names = [];
  let reduced = false;
  let options;
  const Screen = ({ name }) => { names.push(name); return null; };
  const filename = path.resolve(__dirname, '../src/navigation/AppNavigator.tsx');
  const Module = require('node:module');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const icons = new Proxy({}, { get: () => host });
  const mocks = {
    '@react-navigation/bottom-tabs': { createBottomTabNavigator: () => ({ Navigator: props => { options = props.screenOptions; return host(props); }, Screen }) },
    'react-native': { Text: host, useWindowDimensions: () => ({ width: 390 }) },
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
    'lucide-react-native': icons,
    '../ui': { colors: {}, fonts: {}, useReducedMotion: () => reduced },
  };
  loaded.require = name => name.startsWith('../screens/') ? { default: host }
    : name in mocks ? mocks[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename);
  for (const preference of [false, true]) {
    reduced = preference;
    names.length = 0;
    renderToStaticMarkup(React.createElement(loaded.exports.default));
    assert.deepEqual(names, ['Home', 'Diary', 'Library', 'Search']);
    assert.equal(options({ route: { name: 'Home' } }).animation, reduced ? 'none' : 'fade');
  }
});

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

test('summary prioritizes results, preserves expandable transcript and its guarded back action', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const states = [];
  let stateIndex = 0;
  let toggle;
  let header;
  let exits = 0;
  let preventing = false;
  let beforeRemove;
  const action = { type: 'POP_TO_TOP' };
  const host = ({ children }) => React.createElement('div', null, children);
  const session = {
    id: 'ui-summary', phase: 'done', mode: 'meeting-attendee', title: 'Design review',
    transcript: 'Original evidence must remain readable.',
    summary: { decisions: [{ id: 'decision', content: 'Ship on Friday', context: 'Plan approved' }], actionItems: [], keyPoints: [] },
  };
  const screen = loadService('../src/screens/SummaryScreen.tsx', {
    react: { ...React, useState: initial => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    } },
    'react-native': { View: host, Text: host, ScrollView: host, ActivityIndicator: host, Alert: {}, Platform: { OS: 'web' }, StyleSheet: { create: styles => styles },
      TouchableOpacity: props => { if (props.accessibilityLabel === 'Transcript') toggle = props.onPress; return host(props); } },
    '@react-navigation/native': { useRoute: () => ({ params: { session } }),
      usePreventRemove: (enabled, callback) => { preventing = enabled; beforeRemove = callback; },
      useNavigation: () => ({ popToTop: () => { if (preventing) beforeRemove({ data: { action } }); else exits++; },
        dispatch: dispatched => { assert.equal(dispatched, action); exits++; } }) },
    '../services/storage': {}, '../services/processingQueue': { getQueueState: () => ({ running: true, sessionId: session.id }) }, '../services/export': {},
    'lucide-react-native': new Proxy({}, { get: () => host }),
    '../ui': { colors: {}, fonts: {}, uiStyles: {}, IconButton: host, PageEntrance: host,
      ScreenHeader: props => { header = props; return host({ children: props.title }); } },
  });
  const render = () => { stateIndex = 0; return renderToStaticMarkup(React.createElement(screen.default)); };
  const collapsed = render();
  assert.ok(collapsed.includes('Ship on Friday'));
  assert.ok(!collapsed.includes(session.transcript), 'long transcript must be collapsed initially');
  assert.equal(typeof toggle, 'function');
  toggle();
  const expanded = render();
  assert.ok(expanded.indexOf('Ship on Friday') < expanded.indexOf(session.transcript));
  assert.equal(typeof header.onBack, 'function');
  header.onBack();
  assert.equal(exits, 1);
  const originalWindow = global.window;
  try {
    states[0] = { ...session, phase: 'queued' }; render();
    assert.equal(preventing, true, 'system removal must use the same guard as the visible Back control');
    global.window = { confirm: () => false }; header.onBack(); assert.equal(exits, 1);
    global.window.confirm = () => true; header.onBack(); assert.equal(exits, 2);
  } finally { global.window = originalWindow; }
});

test('summary retry resumes status subscriptions and keeps failed transcript collapsed', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const states = [];
  let stateIndex = 0;
  let effect;
  let previousDependencies;
  let retry;
  let listener;
  let starts = 0;
  let subscriptions = 0;
  let rejectRetry = true;
  let saved = { id: 'retry-summary', phase: 'failed', mode: 'meeting-attendee', title: 'Retry review', transcript: 'Full original evidence.' };
  const initial = saved;
  const host = ({ children }) => React.createElement('div', null, children);
  const screen = loadService('../src/screens/SummaryScreen.tsx', {
    react: { ...React, useState: value => { const index = stateIndex++; if (!(index in states)) states[index] = value;
      return [states[index], next => { states[index] = typeof next === 'function' ? next(states[index]) : next; }]; },
      useEffect: (action, dependencies) => { effect = { action, dependencies }; } },
    'react-native': { View: host, Text: host, ScrollView: host, ActivityIndicator: host, Platform: { OS: 'web' }, Alert: {}, StyleSheet: { create: styles => styles },
      TouchableOpacity: props => { if (props.accessibilityLabel === 'Retry Processing' || props.children?.some?.(child => child?.props?.children === 'Retry Processing')) retry = props.onPress; return host(props); } },
    '@react-navigation/native': { useNavigation: () => ({}), useRoute: () => ({ params: { session: initial } }), usePreventRemove() {} },
    '../services/storage': { getSessionById: async () => saved, updateSessionPhase: async () => { if (rejectRetry) throw new Error('storage unavailable'); saved = { ...saved, phase: 'queued' }; } },
    '../services/processingQueue': { startProcessing: () => starts++, addQueueListener: callback => { listener = callback; subscriptions++; return () => {}; } },
    '../services/export': {}, 'lucide-react-native': new Proxy({}, { get: () => host }),
    '../ui': { colors: {}, fonts: {}, uiStyles: {}, IconButton: host, PageEntrance: host, ScreenHeader: host },
  });
  const interval = global.setInterval;
  const clear = global.clearInterval;
  let cleanup;
  const render = () => {
    stateIndex = 0;
    const markup = renderToStaticMarkup(React.createElement(screen.default));
    if (!previousDependencies || effect.dependencies.some((value, index) => value !== previousDependencies[index])) {
      cleanup?.(); cleanup = effect.action(); previousDependencies = effect.dependencies;
    }
    return markup;
  };
  try {
    global.setInterval = () => 1; global.clearInterval = () => {};
    assert.ok(!render().includes(initial.transcript));
    await retry(); assert.ok(render().includes('Could not retry recording.')); assert.equal(starts, 0);
    rejectRetry = false; await retry(); render();
    assert.equal(starts, 1); assert.equal(subscriptions, 1);
    saved = { ...saved, phase: 'done', summary: { decisions: [{ id: 'result', content: 'Recovered decision', context: '' }], actionItems: [], keyPoints: [] } };
    await listener(); assert.ok(render().includes('Recovered decision'));
  } finally { cleanup?.(); global.setInterval = interval; global.clearInterval = clear; }
});

test('library deletion is independently clickable and requires web confirmation', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const parentButton = React.createContext(false);
  let stateIndex = 0;
  let remove;
  const deleted = [];
  const row = { id: 'recording', topic: 'Review', date: '2026-11-03', phase: 'done' };
  const group = { courseName: 'Meetings', sessionCount: 1, sessions: [row] };
  const host = ({ children }) => React.createElement('div', null, children);
  const screen = loadService('../src/screens/HistoryScreen.tsx', {
    react: { ...React, useState: initial => [stateIndex++ === 0 ? [group] : initial === true ? false : initial, () => {}] },
    'react-native': { View: host, Text: host, ActivityIndicator: host, StyleSheet: { create: styles => styles }, Platform: { OS: 'web' },
      TouchableOpacity: props => React.createElement(parentButton.Provider, { value: true }, host(props)),
      SectionList: props => props.renderItem({ item: row }), Alert: { alert: () => { throw new Error('native alert used on web'); } } },
    '@react-navigation/native': { useNavigation: () => ({ addListener: () => () => {}, navigate() {} }) },
    '../services/storage': { deleteSession: async id => deleted.push(id), getAllSessions: async () => [] },
    '../services/courses': { getCourseGroups: async () => [] },
    'lucide-react-native': new Proxy({}, { get: () => host }),
    '../ui': { colors: {}, fonts: {}, PageEntrance: host, IconButton: props => {
      assert.equal(React.useContext(parentButton), false, 'delete must not be inside the open-recording button');
      remove = props.onPress; return null;
    } },
  });
  const originalWindow = global.window;
  try {
    renderToStaticMarkup(React.createElement(screen.default));
    global.window = { confirm: () => false }; await remove(); assert.deepEqual(deleted, []);
    global.window.confirm = () => true; await remove(); assert.deepEqual(deleted, ['recording']);
  } finally { global.window = originalWindow; }
});

test('library loading and deletion failures remain visible on native and web', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const originalWindow = global.window;
  const host = ({ children }) => React.createElement('div', null, children);
  try {
    for (const platform of ['web', 'android']) {
      const row = { id: 'recording', topic: 'Review', date: '2026-11-03', phase: 'done' };
      const states = [[{ courseName: 'Meetings', sessionCount: 1, sessions: [row] }], false];
      let index = 0;
      let load;
      let remove;
      let confirmDelete;
      const screen = loadService('../src/screens/HistoryScreen.tsx', {
        react: { ...React, useState: initial => { const slot = index++; if (!(slot in states)) states[slot] = initial; return [states[slot], value => { states[slot] = value; }]; },
          useCallback: action => { load = action; return action; } },
        'react-native': { View: host, Text: host, TouchableOpacity: host, StyleSheet: { create: styles => styles }, Platform: { OS: platform },
          ActivityIndicator: () => host({ children: 'Loading recordings' }), SectionList: props => props.renderItem({ item: row }),
          Alert: { alert: (_title, _message, actions) => { confirmDelete = actions.find(action => action.text === 'Delete').onPress; } } },
        '@react-navigation/native': { useNavigation: () => ({ addListener: () => () => {} }) },
        '../services/storage': { getAllSessions: async () => { throw new Error('private database error'); }, deleteSession: async () => { throw new Error('private database error'); } },
        '../services/courses': {}, 'lucide-react-native': new Proxy({}, { get: () => host }),
        '../ui': { colors: {}, fonts: {}, PageEntrance: host, IconButton: props => { remove = props.onPress; return null; } },
      });
      const render = () => { index = 0; return renderToStaticMarkup(React.createElement(screen.default)); };
      render(); await load();
      const failedLoad = render();
      assert.ok(failedLoad.includes('Could not load recordings.'));
      assert.ok(!failedLoad.includes('Loading recordings'));
      global.window = { confirm: () => true };
      await remove(); if (platform === 'android') await confirmDelete();
      const failedDelete = render();
      assert.ok(failedDelete.includes('Could not delete the recording.'));
      assert.ok(!failedDelete.includes('private database error'));
    }
  } finally { global.window = originalWindow; }
});

test('key persistence rejects failed mutations without replacing cached credentials', async () => {
  const originalStorage = global.localStorage;
  try {
    for (const platform of ['web', 'android']) {
      let fail = true;
      const values = new Map([['api_key', 'old-model-key'], ['siliconflow_api_key', 'old-speech-key']]);
      const store = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => { if (fail) throw new Error('storage unavailable'); values.set(key, value); },
        removeItem: key => { if (fail) throw new Error('storage unavailable'); values.delete(key); },
      };
      global.localStorage = store;
      const mocks = { 'react-native': { Platform: { OS: platform } },
        'expo-secure-store': { getItemAsync: store.getItem, setItemAsync: store.setItem, deleteItemAsync: store.removeItem } };
      const api = loadService('../src/services/api.ts', mocks);
      const speech = loadService('../src/services/embedding.ts', mocks);
      assert.equal(await speech.getSiliconFlowKey(), 'old-speech-key');
      await assert.rejects(api.saveApiKey('new-model-key'), /storage unavailable/);
      await assert.rejects(api.deleteApiKey(), /storage unavailable/);
      await assert.rejects(api.saveModelConfig({ endpoint: 'https://example.com/v1/messages', model: 'test', contextLimit: 8192, format: 'anthropic' }), /storage unavailable/);
      await assert.rejects(speech.saveSiliconFlowKey('new-speech-key'), /storage unavailable/);
      assert.equal(await speech.getSiliconFlowKey(), 'old-speech-key');
      fail = false; await speech.saveSiliconFlowKey('new-speech-key');
      fail = true; await assert.rejects(speech.deleteSiliconFlowKey(), /storage unavailable/);
      assert.equal(await speech.getSiliconFlowKey(), 'new-speech-key');
      fail = false; await speech.deleteSiliconFlowKey();
      assert.equal(await speech.getSiliconFlowKey(), null);
      assert.equal(await api.getApiKey(), 'old-model-key');
    }
  } finally { global.localStorage = originalStorage; }
});

test('provider output limit is rejected even when partial text exists', () => {
  const api = loadService('../src/services/api.ts', { 'react-native': { Platform: { OS: 'web' } } });
  assert.equal(typeof api.parseLLMResponse, 'function');
  assert.throws(() => api.parseLLMResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] }), /truncat/i);
});

test('settings reports empty input and failed or successful persistence without depending on native alerts', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const states = [];
  let stateIndex = 0;
  let changeKey;
  let save;
  let writes = 0;
  let fail = true;
  const host = ({ children }) => React.createElement('div', null, children);
  const screen = loadService('../src/screens/SettingsScreen.tsx', {
    react: { ...React, useState: initial => {
      const index = stateIndex++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    } },
    'react-native': { View: host, Text: host, ScrollView: host, TouchableOpacity: host, ActivityIndicator: host, StyleSheet: { create: styles => styles },
      TextInput: props => { if (props.accessibilityLabel === 'Model API key') changeKey = props.onChangeText; return null; } },
    '../services/api': { saveApiKey: async () => { writes++; if (fail) throw new Error('storage unavailable'); } },
    '../services/embedding': {},
    'lucide-react-native': new Proxy({}, { get: () => host }),
    '../ui': { colors: {}, fonts: {}, uiStyles: {}, ScreenHeader: host, PageEntrance: host,
      IconButton: props => { if (props.label === 'Save model API key') save = props.onPress; return null; } },
  });
  const render = () => { stateIndex = 0; return renderToStaticMarkup(React.createElement(screen.default)); };
  render(); await save();
  assert.ok(render().includes('Please enter an API key.'));
  assert.equal(writes, 0);
  changeKey('example-test-key'); render(); await save();
  assert.ok(render().includes('Could not save the model API key.'));
  fail = false; await save();
  assert.ok(render().includes('Model API key saved on-device.'));
  assert.equal(writes, 2);
});

test('document export downloads on web, prints only exported content, and keeps native sharing', async () => {
  const platform = { OS: 'web' };
  const writes = [];
  const shares = [];
  const exports = loadService('../src/services/export.ts', {
    'react-native': { Platform: platform },
    'expo-file-system/legacy': { cacheDirectory: 'file:///cache/', writeAsStringAsync: async (...args) => writes.push(args) },
    'expo-print': { printToFileAsync: async () => ({ uri: 'file:///cache/result.pdf' }) },
    'expo-sharing': { shareAsync: async (...args) => shares.push(args) },
  });
  assert.equal(typeof exports.exportDocument, 'function');
  const originalDocument = global.document;
  const originalWindow = global.window;
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const timeout = global.setTimeout;
  let blob;
  let downloaded = false;
  let printed = 0;
  let html;
  let popup;
  const anchor = { click: () => { downloaded = true; }, remove() {} };
  try {
    URL.createObjectURL = value => { blob = value; return 'blob:test'; };
    URL.revokeObjectURL = url => assert.equal(url, 'blob:test');
    global.setTimeout = callback => { callback(); return 0; };
    global.document = { createElement: () => anchor, body: { appendChild() {} } };
    global.window = { open: () => popup = { document: { open() {}, write: value => { html = value; }, close: () => popup.onload() }, print: () => { printed++; } } };
    await exports.exportDocument('markdown', 'notes', 'Original notes');
    assert.ok(downloaded); assert.equal(anchor.download, 'notes.md');
    assert.equal(await blob.text(), 'Original notes');
    await exports.exportDocument('pdf', 'notes', '<html>Exported evidence</html>');
    assert.equal(html, '<html>Exported evidence</html>'); assert.equal(printed, 1);
    global.window.open = () => null;
    await assert.rejects(exports.exportDocument('pdf', 'notes', 'content'), /pop-up/i);
    platform.OS = 'android';
    await exports.exportDocument('markdown', '../notes', 'Native notes');
    await exports.exportDocument('pdf', 'notes', '<html>Native</html>');
    assert.equal(writes[0][0], 'file:///cache/.._notes.md');
    assert.equal(writes[0][1], 'Native notes');
    assert.equal(shares.length, 2);
    assert.equal(shares[1][1].mimeType, 'application/pdf');
  } finally {
    global.document = originalDocument; global.window = originalWindow;
    URL.createObjectURL = createUrl; URL.revokeObjectURL = revokeUrl; global.setTimeout = timeout;
  }
});

test('thinking-only responses are not accepted as application output', () => {
  const api = loadService('../src/services/api.ts', { 'react-native': { Platform: { OS: 'web' } } });
  assert.equal(typeof api.parseLLMResponse, 'function');
  assert.throws(() => api.parseLLMResponse({ content: [{ type: 'thinking', thinking: 'private reasoning' }] }), /text/i);
});

test('request budget reserves output and protocol space', () => {
  assert.throws(() => context.assertRequestBudget('system', 'x'.repeat(2200), 1000, 4096), /budget/i);
  context.assertRequestBudget('system', 'short', 1000, 4096);
});

test('long session summarization bounds every request and retains the original transcript', async () => {
  const calls = [];
  const service = loadService('../src/services/summarization.ts', {
    './api': {
      getModelConfig: async () => ({ contextLimit: 32768 }),
      callLLM: async (system, user) => {
        calls.push({ system, user });
        if (/compact|压缩/.test(system)) return 'Decision: ship in June. Action: Lee validates.';
        return JSON.stringify({ title: 'Meeting', decisions: [], actionItems: [], attendees: [], problems: [], goals: [], keyPoints: [] });
      },
    },
  });
  const transcript = '\u4e2d\u6587 meeting evidence.\n'.repeat(10000);
  const result = await service.summarize(transcript, 'meeting-organizer', '2026-11-03T08:00:00Z', '2026-11-03T16:00:00Z', 'test-key');
  assert.ok(calls.length > 1);
  assert.ok(calls.every(call => Buffer.byteLength(call.user) < 10000));
  assert.equal(result.speakerLabeledTranscript, transcript);
  assert.ok(calls.every(call => !call.system.includes('"speakerLabeledTranscript"')));
});

test('native SQLite checkpoints are isolated by session, operation and full input', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const database = new DatabaseSync(':memory:');
  const adapter = {
    execAsync: async sql => database.exec(sql),
    runAsync: async (sql, ...args) => database.prepare(sql).run(...args),
    getFirstAsync: async (sql, ...args) => database.prepare(sql).get(...args),
    getAllAsync: async (sql, ...args) => database.prepare(sql).all(...args),
  };
  const storage = loadService('../src/services/storage.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-sqlite': { openDatabaseAsync: async () => adapter },
  });
  assert.equal(typeof storage.saveProcessingCheckpoint, 'function');
  await storage.saveProcessingCheckpoint('session', 'model-a', 'input', 'notes');
  assert.equal(await storage.getProcessingCheckpoint('session', 'model-a', 'input'), 'notes');
  assert.equal(await storage.getProcessingCheckpoint('session', 'model-b', 'input'), null);
  assert.equal(await storage.getProcessingCheckpoint('other', 'model-a', 'input'), null);
  assert.equal(await storage.getProcessingCheckpoint('session', 'model-a', 'changed'), null);
  await storage.insertSession({ id: 'session', createdAt: '2026-11-03', mode: 'meeting-organizer', phase: 'summarizing', audioUri: '', audioDuration: 0 });
  await storage.updateSessionPartialSummary('session', 'progress');
  assert.equal(await storage.getSessionPartialSummary('session'), 'progress');
  await storage.saveProcessingCheckpoint('diary:segment:1', 'stt', 'audio', 'private transcript');
  await storage.deleteProcessingCheckpoints('diary:', true);
  assert.equal(await storage.getProcessingCheckpoint('diary:segment:1', 'stt', 'audio'), null);
  assert.equal(await storage.getProcessingCheckpoint('session', 'model-a', 'input'), 'notes');
  database.close();
});

test('skill extraction handles long transcripts without duplicate retry inserts', async () => {
  const inserted = new Map();
  const calls = [];
  const service = loadService('../src/services/extraction.ts', {
    './api': { getModelConfig: async () => ({ model: 'test', contextLimit: 32768 }), callLLM: async (_, user) => {
      calls.push(user);
      return JSON.stringify([{ name: 'Review', description: 'Review decisions', category: 'decision_framework' }]);
    } },
    './skills': { insertSkill: async item => inserted.set(item.id, item), getSkillById: async id => inserted.get(id), updateSkillEmbedding: async () => {} },
    './embedding': { generateEmbedding: async () => [1] },
    './storage': { getProcessingCheckpoint: async () => null, saveProcessingCheckpoint: async () => {} },
  });
  const transcript = 'Decision evidence. '.repeat(2000);
  await service.extractSkills(transcript, 'meeting-organizer', 'session');
  await service.extractSkills(transcript, 'meeting-organizer', 'session');
  assert.ok(calls.length > 2);
  assert.ok(calls.every(text => Buffer.byteLength(text) < 10000));
  assert.equal(inserted.size, 1);
});

test('queue resumes every pending session once without recomputing saved summaries', async () => {
  const sessions = ['queued', 'transcribing', 'extracting'].map((phase, index) => ({
    id: 'resume-' + index, phase, transcript: 'saved evidence', summary: { title: 'saved' },
    audioUri: 'audio.wav', createdAt: '2026-11-03', mode: 'meeting-organizer',
  }));
  const indexed = [];
  const service = loadService('../src/services/processingQueue.ts', {
    'react-native': { Platform: { OS: 'android' } },
    './storage': {
      getAllSessions: async () => sessions,
      getSessionById: async id => sessions.find(session => session.id === id),
      updateSessionPhase: async (id, phase) => { sessions.find(session => session.id === id).phase = phase; },
      getProcessingCheckpoint: async () => null, saveProcessingCheckpoint: async () => {},
      updateSessionEmbeddingMethod: async () => {},
    },
    './summarization': { summarize: async () => { throw new Error('Must reuse saved summary'); } },
    './vectorStore': { indexSessionSummaries: async id => { indexed.push(id); } },
    './embedding': { getLastEmbeddingMethod: () => 'test' },
    './extraction': { extractSkills: async () => [] },
  });
  await service.resumeStuckTasks();
  for (let turn = 0; turn < 100 && service.getQueueState().running; turn++) await new Promise(setImmediate);
  assert.deepEqual(sessions.map(session => session.phase), ['done', 'done', 'done']);
  assert.deepEqual([...indexed].sort(), sessions.map(session => session.id).sort());
});

test('vector indexing retries replace identical evidence instead of duplicating it', async () => {
  const service = loadService('../src/services/vectorStore.ts', {
    'react-native': { Platform: { OS: 'web' } },
    './embedding': { generateEmbedding: async () => [1, 0] },
  });
  const summary = { decisions: [{ content: 'Ship', context: 'June' }] };
  await service.indexSessionSummaries('session', summary);
  await service.indexSessionSummaries('session', summary);
  assert.equal((await service.getAllEmbeddings()).length, 1);
  assert.equal(service.cosineSim([1], [1, 2]), 0);
});

test('export escapes untrusted summary and transcript HTML', () => {
  const service = loadService('../src/services/export.ts', { 'react-native': { Platform: { OS: 'web' } } });
  const session = { title: '<script>alert(1)</script>', transcript: '<img onerror=alert(1)>', summary: { title: '<b>unsafe</b>' } };
  const html = service.sessionToHtml(session);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img onerror'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(service.sessionToMarkdown(session).includes(session.transcript));
});

test('RAG bounds evidence and returns only the submitted excerpts, not verified claims', async () => {
  const row = { id: 'evidence', sessionId: 'session', contentType: 'decision', contentText: 'evidence '.repeat(8000) };
  let submitted = '';
  const service = loadService('../src/services/ragAgent.ts', {
    './api': { getModelConfig: async () => ({ contextLimit: 8192 }), callLLM: async (_, user) => { submitted = user; return 'evidence'; } },
    './embedding': { generateEmbedding: async () => [1] },
    './vectorStore': { getAllEmbeddings: async () => [row], vectorSearch: async () => [{ embeddingRow: row, similarity: 1 }], keywordSearch: () => [] },
    './storage': { getAllSessions: async () => [] },
    './skills': { searchSkillsByEmbedding: async () => [] },
  });
  const result = await service.askAgent('evidence');
  assert.ok(Buffer.byteLength(submitted) < 5500);
  assert.equal(result.sources.length, 1);
  assert.ok(submitted.includes(result.sources[0]));
  assert.ok(result.sources[0].length < row.contentText.length);
  assert.equal(result.grounded, false);
});

test('long summaries adapt their chunk budget to an 8K model context', async () => {
  let requests = 0;
  const service = loadService('../src/services/summarization.ts', {
    './api': { getModelConfig: async () => ({ contextLimit: 8192 }), callLLM: async (system, user, _, output) => {
      context.assertRequestBudget(system, user, output, 8192);
      requests++;
      return /compact|压缩/.test(system) ? 'Confirmed decision: June.' : JSON.stringify({ title: 'June' });
    } },
  });
  const result = await service.summarize('evidence '.repeat(3000), 'meeting-organizer', '2026-11-03', '2026-11-03');
  assert.ok(requests > 1);
  assert.equal(result.title, 'June');
});

test('bounded Unicode chunks reconstruct every character', () => {
  assert.equal(typeof context.splitText, 'function');
  const text = 'classroom \u4e2d\u6587\ud83d\ude03\n'.repeat(20000);
  const chunks = context.splitText(text, 1000);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(chunk => Buffer.byteLength(chunk) <= 1000));
  assert.ok(chunks.every(chunk => !/[\ud800-\udbff]$/.test(chunk)));
});

test('recursive reduction bounds every level, not just transcript chunks', async () => {
  assert.equal(typeof context.compactText, 'function');
  const calls = [];
  const result = await context.compactText('a'.repeat(40000), async text => {
    calls.push(text);
    return text.slice(0, 150);
  }, 1000);
  assert.ok(calls.length > 40);
  assert.ok(calls.every(text => Buffer.byteLength(text) <= 1000));
  assert.ok(Buffer.byteLength(result) <= 1000);
});

test('nonshrinking reduction fails rather than looping or silently dropping text', async () => {
  assert.equal(typeof context.compactText, 'function');
  await assert.rejects(context.compactText('x'.repeat(2000), async text => text, 1000), /shrink/i);
});

test('already aborted processing makes no model calls', async () => {
  assert.equal(typeof context.compactText, 'function');
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(context.compactText('x'.repeat(2000), async () => {
    calls++;
    return 'notes';
  }, 1000, controller.signal), /abort/i);
  assert.equal(calls, 0);
});
