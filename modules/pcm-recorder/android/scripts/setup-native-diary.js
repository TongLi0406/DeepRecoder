#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const LIBS_DIR = path.join(ROOT, 'libs');
const ASSET_DIR = path.join(ROOT, 'src', 'main', 'assets', 'sherpa');
const LICENSE_DIR = path.join(ROOT, 'src', 'main', 'assets', 'sherpa-license');

const AAR = {
  name: 'sherpa-onnx-1.13.7.aar',
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.7/sherpa-onnx-1.13.7.aar',
  sha256: 'c4ef49e309f24fcee5c106b8a279481aaecaabb078cd37b2cd6e9a62cc8a73c8',
};

const MODELS = [
  {
    name: 'silero_vad.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  },
  {
    name: '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
    sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
  },
];

const LICENSES = [
  {
    name: 'sherpa-onnx-LICENSE',
    url: 'https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/master/LICENSE',
  },
];

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function downloadPinned(entry, outDir) {
  const outPath = path.join(outDir, entry.name);
  const buf = await fetchBuffer(entry.url);
  const hash = sha256Hex(buf);
  if (entry.sha256 && hash !== entry.sha256) {
    throw new Error(`SHA256 mismatch for ${entry.name}. expected=${entry.sha256} actual=${hash}`);
  }
  fs.writeFileSync(outPath, buf);
  return { outPath, hash, size: buf.length };
}

async function main() {
  ensureDir(LIBS_DIR);
  ensureDir(ASSET_DIR);
  ensureDir(LICENSE_DIR);

  const results = [];
  results.push(await downloadPinned(AAR, LIBS_DIR));

  for (const model of MODELS) {
    results.push(await downloadPinned(model, ASSET_DIR));
  }

  for (const license of LICENSES) {
    const outPath = path.join(LICENSE_DIR, license.name);
    const buf = await fetchBuffer(license.url);
    fs.writeFileSync(outPath, buf);
    results.push({ outPath, hash: sha256Hex(buf), size: buf.length });
  }

  const inventoryPath = path.join(ROOT, 'sherpa-native-inventory.json');
  fs.writeFileSync(
    inventoryPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        version: 'v1.13.7',
        files: results,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('Native diary dependencies downloaded and verified.');
  console.log(`Inventory: ${inventoryPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
