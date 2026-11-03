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

test('Record screen cleans up only its own successful capture, including paused and failed-stop states', async () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const scenario of ['not-started', 'start-rejected', 'recording', 'paused', 'stop-rejected', 'stopped', 'auto-started']) {
    const effects = [];
    const actions = [];
    let beforeRemove;
    let cleanupCalls = 0;
    let startCalls = 0;
    const host = ({ children }) => React.createElement('div', null, children);
    const { default: Screen } = loadService('../src/screens/RecordingScreen.tsx', {
      react: {
        ...React,
        useEffect: effect => effects.push(effect),
        useCallback: action => { actions.push(action); return action; },
      },
      'react-native': { View: host, Text: host, TouchableOpacity: host, Platform: { OS: 'web' }, StyleSheet: { create: styles => styles } },
      '@react-navigation/native': {
        useRoute: () => ({ params: { mode: 'meeting-attendee', autoStart: scenario === 'auto-started' } }),
        useNavigation: () => ({
          addListener: (name, listener) => { if (name === 'beforeRemove') beforeRemove = listener; return () => {}; },
          replace: () => {},
        }),
      },
      '../services/recording': {
        startRecording: async () => {
          startCalls++;
          if (scenario === 'start-rejected') throw new Error('Another recording is already active');
          return { simulated: false };
        },
        stopRecording: async () => {
          if (scenario === 'stop-rejected') throw new Error('Stop failed');
          return { uri: 'file:///own.wav', durationMs: 1000, transcript: '', simulated: false };
        },
        pauseRecording: async () => {}, resumeRecording: async () => {},
        cleanupRecording: async () => { cleanupCalls++; },
      },
      '../services/storage': { insertSession: async () => {} },
      'lucide-react-native': new Proxy({}, { get: () => host }),
      '../ui': { colors: {}, fonts: {}, uiStyles: {}, IconButton: host, ScreenHeader: host, RecordingPulse: host, PageEntrance: host },
    });
    renderToStaticMarkup(React.createElement(Screen));
    const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function');
    await Promise.resolve();
    if (scenario === 'auto-started') {
      assert.equal(startCalls, 1, 'only explicit start intent auto-starts the recording');
      await actions[0]();
      assert.equal(startCalls, 1, 'repeated start does not acquire the microphone twice');
    } else if (scenario !== 'not-started') await actions[0]();
    if (scenario === 'paused') await actions[1]();
    if (scenario === 'stop-rejected' || scenario === 'stopped') await actions[2]();
    const ownsCapture = ['recording', 'paused', 'stop-rejected', 'auto-started'].includes(scenario);
    let blocked = false;
    beforeRemove({ preventDefault: () => { blocked = true; } });
    assert.equal(blocked, ownsCapture, `${scenario}: navigation must track capture ownership`);
    for (const cleanup of cleanups) cleanup();
    assert.equal(cleanupCalls, ownsCapture ? 1 : 0, `${scenario}: must not stop enrollment or another capture`);
  }
});

test('home starts recording once from an explicit button press, not from rendering', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const destinations = [];
  let start;
  const host = ({ children, onPress, accessibilityLabel }) => {
    if (accessibilityLabel === 'Start Recording' || children?.props?.children === 'Start Recording') start = onPress;
    return React.createElement('div', null, children);
  };
  const screen = loadService('../src/screens/HomeScreen.tsx', {
    react: { ...React, useState: value => [typeof value === 'object' && value === null ? 'meeting-attendee' : value, () => {}] },
    'react-native': { View: host, Text: host, ScrollView: host, TouchableOpacity: host, Pressable: host,
      StyleSheet: { create: styles => styles }, useWindowDimensions: () => ({ width: 390 }) },
    '@react-navigation/native': { useNavigation: () => ({ navigate: (...args) => destinations.push(args) }), useFocusEffect: () => {} },
    '../services/storage': { getAllSessions: async () => [] },
    'lucide-react-native': new Proxy({}, { get: () => host }),
    '../ui': { colors: {}, fonts: {}, uiStyles: {}, ScreenHeader: host, PageEntrance: host },
  });
  renderToStaticMarkup(React.createElement(screen.default));
  assert.equal(destinations.length, 0);
  assert.equal(typeof start, 'function');
  start();
  assert.deepEqual(destinations, [['Recording', { mode: 'meeting-attendee', autoStart: true }]]);
});

test('recording motion runs only for active foreground focused capture without reduced motion', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const host = ({ children }) => React.createElement('div', null, children);
  for (const scenario of [
    { active: true, reduced: false, foreground: true, focused: true, expected: 1 },
    { active: false, reduced: false, foreground: true, focused: true, expected: 0 },
    { active: true, reduced: true, foreground: true, focused: true, expected: 0 },
    { active: true, reduced: false, foreground: false, focused: true, expected: 0 },
    { active: true, reduced: false, foreground: true, focused: false, expected: 0 },
  ]) {
    const effects = [];
    let starts = 0;
    let stops = 0;
    let index = 0;
    const states = [scenario.reduced, scenario.foreground];
    const ui = loadService('../src/ui.tsx', {
      react: { ...React, useState: () => [states[index++], () => {}], useEffect: effect => effects.push(effect) },
      'react-native': {
        View: host, Text: host, Pressable: host, Platform: { OS: 'android' },
        StyleSheet: { create: styles => styles, absoluteFillObject: {} },
        AccessibilityInfo: { isReduceMotionEnabled: async () => scenario.reduced, addEventListener: () => ({ remove() {} }) },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Animated: {
          View: host, Value: class { setValue() {} interpolate() { return 1; } },
          timing: () => ({}), sequence: () => ({}),
          loop: () => ({ start: () => starts++, stop: () => stops++ }),
        },
      },
      '@react-navigation/native': { useIsFocused: () => scenario.focused },
      'react-native-safe-area-context': {}, 'lucide-react-native': {},
    });
    assert.equal(typeof ui.RecordingPulse, 'function');
    renderToStaticMarkup(React.createElement(ui.RecordingPulse, { active: scenario.active }));
    const cleanups = effects.map(effect => effect()).filter(cleanup => typeof cleanup === 'function');
    assert.equal(starts, scenario.expected, JSON.stringify(scenario));
    for (const cleanup of cleanups) cleanup();
    assert.equal(stops, starts, 'all loop handles must stop on cleanup');
  }
});

test('icon hover and keyboard tooltips stay within narrow viewport edges', () => {
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  for (const location of [{ horizontal: 24, vertical: 24 }, { horizontal: 252, vertical: 690 }, { horizontal: 252, vertical: 624 }, { horizontal: 120, vertical: 320 }]) {
    const states = [];
    let stateIndex = 0;
    let button;
    let tooltip;
    let lineLimit;
    const host = ({ children }) => React.createElement('div', null, children);
    const ui = loadService('../src/ui.tsx', {
      react: { ...React, useState: initial => {
        const index = stateIndex++;
        if (!(index in states)) states[index] = initial;
        return [states[index], value => { states[index] = value; }];
      }, useRef: () => ({ current: { measureInWindow: callback => callback(location.horizontal, location.vertical) } }) },
      'react-native': { Text: props => { lineLimit = props.numberOfLines; return host(props); }, StyleSheet: { create: styles => styles }, useWindowDimensions: () => ({ width: 320, height: 740 }),
        Pressable: props => { button = props; return host(props); },
        View: props => { tooltip = Object.assign({}, ...props.style); return host(props); } },
      '@react-navigation/native': {}, 'react-native-safe-area-context': {}, 'lucide-react-native': {},
    });
    const render = () => { stateIndex = 0; return renderToStaticMarkup(React.createElement(ui.IconButton, { label: 'Send question', icon: host, onPress() {} })); };
    render(); button.onHoverIn();
    assert.ok(render().includes('Send question'));
    assert.ok(location.horizontal + tooltip.left >= 8);
    assert.ok(location.horizontal + tooltip.left + tooltip.width <= 312);
    assert.equal(lineLimit, 3, 'long recording titles must not grow the tooltip beyond its positioning budget');
    assert.equal(tooltip.bottom === 48, location.vertical + 126 > 740);
    button.onHoverOut(); assert.ok(!render().includes('Send question'));
    button.onFocus(); assert.ok(render().includes('Send question'));
    button.onBlur(); assert.ok(!render().includes('Send question'));
  }
});

function writeU16LE(buf, off, value) {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >> 8) & 0xff;
}

function writeU32LE(buf, off, value) {
  buf[off] = value & 0xff;
  buf[off + 1] = (value >> 8) & 0xff;
  buf[off + 2] = (value >> 16) & 0xff;
  buf[off + 3] = (value >> 24) & 0xff;
}

function makeWavHeader(dataBytes, sampleRate = 16000, channels = 1, bits = 16) {
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const out = new Uint8Array(44);
  out.set(Buffer.from('RIFF'), 0);
  writeU32LE(out, 4, 36 + dataBytes);
  out.set(Buffer.from('WAVE'), 8);
  out.set(Buffer.from('fmt '), 12);
  writeU32LE(out, 16, 16);
  writeU16LE(out, 20, 1);
  writeU16LE(out, 22, channels);
  writeU32LE(out, 24, sampleRate);
  writeU32LE(out, 28, byteRate);
  writeU16LE(out, 32, blockAlign);
  writeU16LE(out, 34, bits);
  out.set(Buffer.from('data'), 36);
  writeU32LE(out, 40, dataBytes);
  return out;
}

function makeFsMock(seed = {}) {
  const files = new Map();
  const cachePrefix = 'file:///cache/';
  const now = 1700000000000;
  for (const [uri, value] of Object.entries(seed)) {
    files.set(uri, {
      uri,
      bytes: value.bytes,
      size: value.bytes.length,
      lastModified: value.lastModified ?? now,
      deleted: false,
      virtual: !!value.virtual,
    });
  }

  class FileHandle {
    constructor(entry, mode) {
      this.entry = entry;
      this.mode = mode;
      this.offset = 0;
      this.closed = false;
      this.maxRead = 0;
    }

    get size() {
      return this.closed ? null : this.entry.size;
    }

    close() {
      this.closed = true;
    }

    readBytes(length) {
      if (this.closed) throw new Error('closed');
      this.maxRead = Math.max(this.maxRead, length);
      const available = Math.max(0, this.entry.size - this.offset);
      const n = Math.min(length, available);
      const out = new Uint8Array(n);
      if (this.entry.virtual) {
        const seeded = this.entry.bytes;
        const seededLen = Math.max(0, Math.min(seeded.length - this.offset, n));
        if (seededLen > 0) out.set(seeded.slice(this.offset, this.offset + seededLen), 0);
        for (let i = seededLen; i < n; i++) out[i] = (this.offset + i) % 251;
      } else {
        out.set(this.entry.bytes.slice(this.offset, this.offset + n));
      }
      this.offset += n;
      return out;
    }

    writeBytes(bytes) {
      if (this.closed) throw new Error('closed');
      const end = this.offset + bytes.length;
      if (end > this.entry.bytes.length) {
        const grown = new Uint8Array(end);
        grown.set(this.entry.bytes, 0);
        this.entry.bytes = grown;
      }
      this.entry.bytes.set(bytes, this.offset);
      this.offset = end;
      this.entry.size = this.entry.bytes.length;
    }
  }

  class File {
    constructor(base, name) {
      if (name === undefined) {
        this.uri = String(base);
      } else {
        this.uri = String(base).replace(/\/$/, '') + '/' + String(name).replace(/^\//, '');
      }
      if (!files.has(this.uri)) {
        files.set(this.uri, {
          uri: this.uri,
          bytes: new Uint8Array(0),
          size: 0,
          lastModified: now,
          deleted: false,
          virtual: false,
        });
      }
    }

    get exists() {
      const e = files.get(this.uri);
      return !!e && !e.deleted;
    }

    get size() {
      const e = files.get(this.uri);
      return this.exists ? e.size : 0;
    }

    get lastModified() {
      const e = files.get(this.uri);
      return this.exists ? e.lastModified : null;
    }

    get name() {
      return this.uri.split('/').pop() || 'file.wav';
    }

    create() {
      const e = files.get(this.uri);
      e.bytes = new Uint8Array(0);
      e.size = 0;
      e.deleted = false;
      e.virtual = false;
      e.lastModified = now;
    }

    delete() {
      const e = files.get(this.uri);
      if (e) e.deleted = true;
    }

    open(mode) {
      const e = files.get(this.uri);
      return new FileHandle(e, mode);
    }
  }

  return {
    api: {
      File,
      Paths: { cache: 'file:///cache', document: 'file:///document', availableDiskSpace: 1024 * 1024 * 1024 },
      FileMode: { ReadOnly: 'r', ReadWrite: 'rw', WriteOnly: 'w' },
      UploadType: { MULTIPART: 1 },
    },
    files,
    cachePrefix,
  };
}

test('whisper header helper returns canonical 44-byte PCM header', async () => {
  const service = loadService('../src/services/whisper.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system': makeFsMock().api,
    './debug': { debugLog: () => {} },
  });
  assert.equal(typeof service.buildPcm16MonoWavHeader, 'function');
  const header = service.buildPcm16MonoWavHeader(32000);
  assert.equal(header.byteLength, 44);
  const view = new Uint8Array(header);
  assert.equal(Buffer.from(view.slice(0, 4)).toString('ascii'), 'RIFF');
  assert.equal(Buffer.from(view.slice(8, 12)).toString('ascii'), 'WAVE');
  assert.equal(Buffer.from(view.slice(36, 40)).toString('ascii'), 'data');
});

test('remote STT chunks long wav in order with bounded chunk size and supports checkpoint resume', async () => {
  const bytesPerSec = 16000 * 2;
  const chunkBytes = 300 * bytesPerSec;
  const dataBytes = chunkBytes * 2 + bytesPerSec;
  const header = makeWavHeader(dataBytes);
  const sourceBytes = new Uint8Array(44 + dataBytes);
  sourceBytes.set(header, 0);

  const fsMock = makeFsMock({
    'file:///source.wav': { bytes: sourceBytes, virtual: true, lastModified: 1710000000000 },
  });

  const checkpoints = new Map();
  const uploads = [];
  let call = 0;
  class MockXHR {
    open() {}
    setRequestHeader() {}
    send(body) {
      const filePart = body.parts.find(p => p.key === 'file').value;
      uploads.push(filePart.uri);
      call += 1;
      const idx = call;
      const done = () => {
        this.status = 200;
        this.responseText = JSON.stringify({ text: 'seg' + idx });
        this.onload && this.onload();
      };
      setImmediate(done);
    }
    abort() {
      this.onabort && this.onabort();
    }
  }
  class MockFormData {
    constructor() { this.parts = []; }
    append(key, value) { this.parts.push({ key, value }); }
  }

  global.XMLHttpRequest = MockXHR;
  global.FormData = MockFormData;

  const service = loadService('../src/services/remoteStt.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system': fsMock.api,
    './embedding': { getSiliconFlowKey: async () => 'k' },
    './storage': {
      getProcessingCheckpoint: async (scope, op, input) => checkpoints.get(scope + '|' + op + '|' + input) ?? null,
      saveProcessingCheckpoint: async (scope, op, input, result) => checkpoints.set(scope + '|' + op + '|' + input, result),
    },
    './debug': { debugLog: () => {} },
    './whisper': loadService('../src/services/whisper.ts', {
      'react-native': { Platform: { OS: 'android' } },
      'expo-file-system': fsMock.api,
      './debug': { debugLog: () => {} },
    }),
  });

  const text = await service.transcribeRemote('file:///source.wav', undefined, 'scope-a');
  assert.equal(text, 'seg1\nseg2\nseg3');
  assert.equal(uploads.length, 3);
  for (const uri of uploads) {
    const entry = fsMock.files.get(uri);
    assert.ok(entry.size <= 10000044);
  }

  checkpoints.delete([...checkpoints.keys()].find(key => /chunk:1\//.test(key)));
  uploads.length = 0;
  call = 0;
  const text2 = await service.transcribeRemote('file:///source.wav', undefined, 'scope-a');
  assert.equal(text2.split('\n').length, 3);
  assert.equal(uploads.length, 1);
});

test('remote STT abort propagates to active request and does not retry abort', async () => {
  const dataBytes = 16000 * 2 * 10;
  const src = new Uint8Array(44 + dataBytes);
  src.set(makeWavHeader(dataBytes), 0);
  const fsMock = makeFsMock({ 'file:///short.wav': { bytes: src } });

  let abortCalls = 0;
  class MockXHR {
    open() {}
    setRequestHeader() {}
    send() {}
    abort() {
      abortCalls += 1;
      setImmediate(() => this.onabort && this.onabort());
    }
  }
  class MockFormData { append() {} }
  global.XMLHttpRequest = MockXHR;
  global.FormData = MockFormData;

  const service = loadService('../src/services/remoteStt.ts', {
    'react-native': { Platform: { OS: 'android' } },
    'expo-file-system': fsMock.api,
    './embedding': { getSiliconFlowKey: async () => 'k' },
    './storage': {
      getProcessingCheckpoint: async () => null,
      saveProcessingCheckpoint: async () => {},
    },
    './debug': { debugLog: () => {} },
    './whisper': loadService('../src/services/whisper.ts', {
      'react-native': { Platform: { OS: 'android' } },
      'expo-file-system': fsMock.api,
      './debug': { debugLog: () => {} },
    }),
  });

  const controller = new AbortController();
  const pending = service.transcribeRemote('file:///short.wav', controller.signal, 'scope-b');
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, /aborted/i);
  assert.equal(abortCalls, 1);
});

test('recording uses native PCM permission flow, pause/resume wrappers and native duration', async () => {
  let startCalls = 0;
  let pauseCalls = 0;
  let resumeCalls = 0;
  let stopCalls = 0;
  let permissionChecks = 0;
  let permissionRequests = 0;

  let permissionGranted = false;
  const service = loadService('../src/services/recording.ts', {
    'react-native': { Platform: { OS: 'android' } },
    '../../modules/pcm-recorder/src': {
      PcmRecorder: {
        hasPermission: () => permissionGranted,
        getDiaryStatus: async () => ({ active: false }),
        startRecording: async () => { startCalls += 1; return { filePath: 'file:///pcm.wav' }; },
        pauseRecording: async () => { pauseCalls += 1; return {}; },
        resumeRecording: async () => { resumeCalls += 1; return {}; },
        stopRecording: async () => { stopCalls += 1; return { filePath: 'file:///pcm.wav', durationMs: 12345 }; },
      },
    },
    'expo-audio': {
      getRecordingPermissionsAsync: async () => { permissionChecks += 1; return { granted: false, status: 'denied' }; },
      requestRecordingPermissionsAsync: async () => {
        permissionRequests += 1;
        permissionGranted = true;
        return { granted: true, status: 'granted' };
      },
      setAudioModeAsync: async () => {},
      AudioModule: { AudioRecorder: function() {} },
      RecordingPresets: { HIGH_QUALITY: {} },
    },
  });

  const started = await service.startRecording();
  assert.equal(started.simulated, false);
  await service.pauseRecording();
  await service.resumeRecording();
  const done = await service.stopRecording(99999);
  assert.equal(done.durationMs, 12345);
  assert.equal(startCalls, 1);
  assert.equal(pauseCalls, 1);
  assert.equal(resumeCalls, 1);
  assert.equal(stopCalls, 1);
  assert.equal(permissionChecks, 1);
  assert.equal(permissionRequests, 1);
});

test('recording blocks start when diary capture is active', async () => {
  const service = loadService('../src/services/recording.ts', {
    'react-native': { Platform: { OS: 'android' } },
    '../../modules/pcm-recorder/src': {
      PcmRecorder: {
        hasPermission: () => true,
        getDiaryStatus: async () => ({ active: true }),
      },
    },
    'expo-audio': {
      getRecordingPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
      requestRecordingPermissionsAsync: async () => ({ granted: true, status: 'granted' }),
      setAudioModeAsync: async () => {},
      AudioModule: { AudioRecorder: function() {} },
      RecordingPresets: { HIGH_QUALITY: {} },
    },
  });
  await assert.rejects(service.startRecording(), /diary capture is active/i);
});

test('recovery preserves in-flight phases as queued and does not treat 429 as credit exhausted', async () => {
  const updates = [];
  const service = loadService('../src/services/recovery.ts', {
    'react-native': { Platform: { OS: 'android' } },
    './storage': {
      getAllSessions: async () => [
        { id: 'a', phase: 'transcribing', createdAt: '2020-01-01T00:00:00.000Z' },
        { id: 'b', phase: 'summarizing', createdAt: '2020-01-01T00:00:00.000Z' },
        { id: 'c', phase: 'recording', createdAt: '2020-01-01T00:00:00.000Z' },
      ],
      updateSessionPhase: async (id, phase, error) => updates.push({ id, phase, error }),
      updateSessionPartialSummary: async () => {},
      getSessionById: async () => null,
    },
    'expo-file-system': makeFsMock().api,
  });

  await service.recoverInterruptedSessions();
  assert.deepEqual(updates.map(x => x.phase), ['queued', 'queued']);
  assert.equal(service.isCreditExhausted('HTTP 429 rate_limit'), false);
  assert.equal(service.isCreditExhausted('insufficient_quota'), true);
});
