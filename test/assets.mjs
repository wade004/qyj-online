import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BGM_TRACKS, SFX } from '../js/audio.js';
import {
  RANK_FACE_IMGS,
  SUIT_IMGS,
} from '../js/game/config.js';
import { HEROES } from '../js/game/heroes.js';
import { SKILLS } from '../js/game/skills.js';
import { H5_STATIC_PATHS } from '../js/services/asset-variants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'assets', 'runtime-manifest.json');
const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function sorted(values) {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function sameValues(actual, expected, label) {
  const a = sorted(actual);
  const e = sorted(expected);
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    const actualSet = new Set(a);
    const expectedSet = new Set(e);
    const missing = e.filter((item) => !actualSet.has(item));
    const extra = a.filter((item) => !expectedSet.has(item));
    if (missing.length) fail(`${label} missing: ${missing.join(', ')}`);
    if (extra.length) fail(`${label} extra: ${extra.join(', ')}`);
  }
}

function toFsPath(relativePath) {
  return path.join(ROOT, ...relativePath.split('/'));
}

function extensionFormat(assetPath) {
  const extension = path.posix.extname(assetPath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'jpeg';
  if (extension === '.png') return 'png';
  if (extension === '.webp') return 'webp';
  if (extension === '.mp3') return 'mp3';
  return extension.slice(1) || 'unknown';
}

function sniffFormat(buffer) {
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) return 'png';

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (
    buffer.length >= 12
    && buffer.toString('ascii', 0, 4) === 'RIFF'
    && buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return 'webp';

  if (
    (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3')
    || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) return 'mp3';

  return 'unknown';
}

function cssAssetPaths(cssPath, source) {
  const found = [];
  const pattern = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    const reference = match[2].trim().split(/[?#]/, 1)[0];
    if (!reference || /^(?:data:|https?:|\/\/)/i.test(reference)) continue;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(cssPath), reference));
    if (resolved.startsWith('assets/')) found.push(resolved);
  }
  return found;
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
assert(manifest.schemaVersion === 1, 'runtime-manifest schemaVersion must be 1');
assert(manifest.entrypoints?.includes('index.html'), 'runtime-manifest must declare index.html');
assert(manifest.entrypoints?.includes('h5.html'), 'runtime-manifest must declare h5.html');

const imageGroups = manifest.runtime?.images || {};
const manifestImages = Object.values(imageGroups).flatMap((group) => (
  Array.isArray(group) ? group : []
));
const manifestBgm = manifest.runtime?.audio?.bgmTracks || [];
const manifestSfx = manifest.runtime?.audio?.sfx || {};
const manifestAliases = manifest.runtime?.audio?.sfxAliases || {};
const runtimeAssets = [...new Set([
  ...manifestImages,
  ...manifestBgm,
  ...Object.values(manifestSfx),
])];

assert(runtimeAssets.length > 0, 'runtime-manifest contains no runtime assets');
assert(
  JSON.stringify(manifestBgm) === JSON.stringify(BGM_TRACKS),
  'runtime-manifest BGM order/paths differ from js/audio.js',
);

const sourceSfxKeys = Object.keys(SFX);
const manifestSfxKeys = Object.keys(manifestSfx);
sameValues(manifestSfxKeys, sourceSfxKeys, 'audio SFX keys');
for (const key of new Set([...sourceSfxKeys, ...manifestSfxKeys])) {
  if (SFX[key] !== manifestSfx[key]) {
    fail(`audio SFX path differs for ${key}: manifest=${manifestSfx[key]} source=${SFX[key]}`);
  }
}

for (const [alias, target] of Object.entries(manifestAliases)) {
  assert(alias in manifestSfx, `SFX alias ${alias} is not registered`);
  assert(target in manifestSfx, `SFX alias target ${target} is not registered`);
  assert(
    manifestSfx[alias] === manifestSfx[target],
    `SFX alias ${alias} must resolve to the same file as ${target}`,
  );
}

const skillSfxKeys = new Set(
  Object.values(SKILLS)
    .map((skill) => skill.presentation?.sfx)
    .filter(Boolean),
);
for (const key of skillSfxKeys) {
  assert(key in SFX, `skill presentation references unregistered SFX key: ${key}`);
}

const cssPath = 'css/style.css';
const cssSource = await readFile(toFsPath(cssPath), 'utf8');
const sourceRuntimeAssets = new Set([
  ...BGM_TRACKS,
  ...Object.values(SFX),
  ...HEROES.map((hero) => hero.portrait),
  ...H5_STATIC_PATHS,
  ...Object.values(RANK_FACE_IMGS),
  ...Object.values(SUIT_IMGS),
  ...cssAssetPaths(cssPath, cssSource),
]);
sameValues(runtimeAssets, sourceRuntimeAssets, 'runtime asset manifest');

const knownMismatches = manifest.formatPolicy?.knownExtensionMismatches || {};
const knownMismatchAction = manifest.formatPolicy?.knownMismatchAction;
const unexpectedMismatchAction = manifest.formatPolicy?.unexpectedMismatchAction;
assert(knownMismatchAction === 'warn', 'known format mismatches must use warn policy');
assert(unexpectedMismatchAction === 'error', 'unexpected format mismatches must use error policy');

let totalBytes = 0;
for (const assetPath of runtimeAssets) {
  const normalized = path.posix.normalize(assetPath);
  assert(normalized === assetPath, `asset path is not normalized: ${assetPath}`);
  assert(assetPath.startsWith('assets/'), `runtime asset must stay under assets/: ${assetPath}`);
  assert(!path.posix.isAbsolute(assetPath), `runtime asset must be relative: ${assetPath}`);
  if (normalized.startsWith('../') || normalized.includes('/../')) {
    fail(`runtime asset escapes repository root: ${assetPath}`);
    continue;
  }

  let fileStat;
  let header;
  try {
    fileStat = await stat(toFsPath(assetPath));
    header = await readFile(toFsPath(assetPath));
  } catch (error) {
    fail(`runtime asset is missing or unreadable: ${assetPath} (${error.code || error.message})`);
    continue;
  }

  assert(fileStat.isFile(), `runtime asset is not a file: ${assetPath}`);
  totalBytes += fileStat.size;

  const declared = extensionFormat(assetPath);
  const actual = sniffFormat(header.subarray(0, 32));
  const knownActual = knownMismatches[assetPath];
  if (actual === 'unknown') {
    fail(`cannot identify runtime asset format: ${assetPath}`);
  } else if (actual !== declared) {
    if (knownActual === actual) {
      warnings.push(`${assetPath}: extension=${declared}, actual=${actual}`);
    } else {
      fail(`unexpected format mismatch: ${assetPath} extension=${declared}, actual=${actual}`);
    }
  } else if (knownActual) {
    fail(`stale knownExtensionMismatches entry: ${assetPath} now matches ${actual}`);
  }
}

for (const [assetPath, expectedActual] of Object.entries(knownMismatches)) {
  assert(runtimeAssets.includes(assetPath), `known format mismatch is not a runtime asset: ${assetPath}`);
  assert(
    ['jpeg', 'png', 'webp', 'mp3'].includes(expectedActual),
    `unsupported known mismatch format for ${assetPath}: ${expectedActual}`,
  );
}

if (warnings.length) {
  console.warn(`资源格式提示（${knownMismatchAction}，已登记 ${warnings.length} 项）：`);
  for (const warning of warnings) console.warn(`  - ${warning}`);
}

if (failures.length) {
  console.error(`资源自检失败（${failures.length} 项）：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    `资源自检通过：${runtimeAssets.length} 个唯一运行时资源，`
    + `${Object.keys(SFX).length} 个音效键，${(totalBytes / 1024 / 1024).toFixed(2)} MiB。`,
  );
}
