import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_ROOT = path.join(ROOT, 'dist', 'public');
const MANIFEST_PATH = path.join(ROOT, 'assets', 'runtime-manifest.json');
const RUNTIME_MANIFEST_OUTPUT = 'assets/runtime-manifest.json';
const ALLOWED_DEPENDENCY_PREFIXES = ['css/', 'js/'];
const FORBIDDEN_RELEASE_PREFIXES = [
  '.git/',
  'artwork/',
  'docs/',
  'logs/',
  'server/',
  'test/',
];

function stripQuery(reference) {
  return reference.split(/[?#]/, 1)[0];
}

function isRemote(reference) {
  return /^(?:[a-z]+:|\/\/)/i.test(reference);
}

function normalizeRelative(reference, importer = '') {
  const clean = stripQuery(reference).replaceAll('\\', '/');
  const resolved = importer
    ? path.posix.normalize(path.posix.join(path.posix.dirname(importer), clean))
    : path.posix.normalize(clean);
  if (
    !resolved
    || path.posix.isAbsolute(resolved)
    || resolved === '..'
    || resolved.startsWith('../')
    || resolved.includes('/../')
  ) {
    throw new Error(`Path escapes the release root: ${reference} (from ${importer || 'manifest'})`);
  }
  return resolved;
}

function toFsPath(root, relativePath) {
  return path.join(root, ...relativePath.split('/'));
}

function collectAssetPaths(manifest) {
  const imageGroups = Object.values(manifest.runtime?.images || {});
  const images = imageGroups.flatMap((group) => (Array.isArray(group) ? group : []));
  const bgm = manifest.runtime?.audio?.bgmTracks || [];
  const sfx = Object.values(manifest.runtime?.audio?.sfx || {});
  const assets = [...images, ...bgm, ...sfx].map((asset) => normalizeRelative(asset));
  for (const asset of assets) {
    if (!asset.startsWith('assets/')) {
      throw new Error(`Runtime asset is outside assets/: ${asset}`);
    }
  }
  return new Set(assets);
}

function htmlDependencies(source) {
  const dependencies = [];
  const pattern = /\b(?:src|href)\s*=\s*(['"])([^'"]+)\1/gi;
  for (const match of source.matchAll(pattern)) {
    const reference = match[2].trim();
    if (!reference || reference.startsWith('#') || isRemote(reference)) continue;
    dependencies.push(reference);
  }
  return dependencies;
}

function jsDependencies(source) {
  const dependencies = new Set();
  const patterns = [
    /\bfrom\s*(['"])([^'"]+)\1/g,
    /\bimport\s*(['"])([^'"]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) dependencies.add(match[2]);
  }
  return [...dependencies];
}

function cssDependencies(source) {
  const dependencies = [];
  const importPattern = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?/gi;
  const urlPattern = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi;
  for (const match of source.matchAll(importPattern)) dependencies.push(match[2].trim());
  for (const match of source.matchAll(urlPattern)) dependencies.push(match[2].trim());
  return dependencies;
}

function isAllowedCodeDependency(relativePath, entrypoints) {
  return entrypoints.has(relativePath)
    || ALLOWED_DEPENDENCY_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

async function discoverRuntimeCode(entrypoints, runtimeAssets) {
  const pending = [...entrypoints];
  const discovered = new Set();

  while (pending.length) {
    const relativePath = pending.pop();
    if (discovered.has(relativePath)) continue;
    if (!isAllowedCodeDependency(relativePath, entrypoints)) {
      throw new Error(`Runtime dependency is outside the code allowlist: ${relativePath}`);
    }

    const sourcePath = toFsPath(ROOT, relativePath);
    const sourceStat = await stat(sourcePath).catch(() => null);
    if (!sourceStat?.isFile()) throw new Error(`Runtime dependency is missing: ${relativePath}`);
    discovered.add(relativePath);

    const extension = path.posix.extname(relativePath).toLowerCase();
    if (!['.html', '.js', '.css'].includes(extension)) continue;
    const source = await readFile(sourcePath, 'utf8');
    const references = extension === '.html'
      ? htmlDependencies(source)
      : extension === '.js'
        ? jsDependencies(source)
        : cssDependencies(source);

    for (const reference of references) {
      if (!reference || isRemote(reference) || reference.startsWith('data:')) continue;
      if (extension === '.js' && !reference.startsWith('.')) {
        throw new Error(`Bare browser import is not supported by the static build: ${reference}`);
      }
      const dependency = normalizeRelative(reference, relativePath);
      if (dependency.startsWith('assets/')) {
        if (!runtimeAssets.has(dependency)) {
          throw new Error(`Code references an asset outside runtime-manifest.json: ${dependency}`);
        }
      } else {
        pending.push(dependency);
      }
    }
  }

  return discovered;
}

async function copyRelative(relativePath) {
  const source = toFsPath(ROOT, relativePath);
  const destination = toFsPath(OUTPUT_ROOT, relativePath);
  const sourceStat = await stat(source).catch(() => null);
  if (!sourceStat?.isFile()) throw new Error(`Release file is missing: ${relativePath}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function walkFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(root, absolute));
    else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll('\\', '/'));
  }
  return files;
}

async function makeReleaseReport(files) {
  const reportFiles = [];
  let totalBytes = 0;
  for (const relativePath of files) {
    const data = await readFile(toFsPath(OUTPUT_ROOT, relativePath));
    totalBytes += data.byteLength;
    reportFiles.push({
      path: relativePath,
      bytes: data.byteLength,
      sha256: createHash('sha256').update(data).digest('hex'),
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entrypoints: manifest.entrypoints,
    fileCount: reportFiles.length,
    totalBytes,
    files: reportFiles,
  };
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
if (manifest.schemaVersion !== 1) throw new Error('Unsupported runtime-manifest schemaVersion');

const entrypoints = new Set((manifest.entrypoints || []).map((entry) => normalizeRelative(entry)));
if (!entrypoints.size) throw new Error('runtime-manifest.json has no entrypoints');
for (const entrypoint of entrypoints) {
  if (!/^[a-z0-9][a-z0-9._-]*\.html$/i.test(entrypoint)) {
    throw new Error(`Static entrypoint must be a root-level HTML file: ${entrypoint}`);
  }
}
const runtimeAssets = collectAssetPaths(manifest);
const runtimeCode = await discoverRuntimeCode(entrypoints, runtimeAssets);

await rm(OUTPUT_ROOT, { recursive: true, force: true });
await mkdir(OUTPUT_ROOT, { recursive: true });

const releaseFiles = new Set([
  ...runtimeCode,
  ...runtimeAssets,
  RUNTIME_MANIFEST_OUTPUT,
]);
for (const relativePath of [...releaseFiles].sort()) await copyRelative(relativePath);

const copiedFiles = (await walkFiles(OUTPUT_ROOT)).sort();
for (const relativePath of copiedFiles) {
  if (FORBIDDEN_RELEASE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) {
    throw new Error(`Forbidden path leaked into static release: ${relativePath}`);
  }
}

const report = await makeReleaseReport(copiedFiles);
await writeFile(
  path.join(OUTPUT_ROOT, 'release-manifest.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8',
);

console.log(
  `静态发布构建完成：dist/public（${report.fileCount} 个白名单文件，`
  + `${(report.totalBytes / 1024 / 1024).toFixed(2)} MiB）。`,
);
