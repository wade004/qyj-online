#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { TOURNAMENT_TRAJECTORY_DATASET_SCHEMA } from './tournament-policy/model.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const inputs = String(value('--inputs') || '').split(',').map((item) => item.trim()).filter(Boolean);
const output = value('--output');
const allowProvenanceUnion = args.includes('--allow-provenance-union');
if (inputs.length < 2 || !output) {
  throw new TypeError('--inputs requires at least two comma-separated datasets and --output is required');
}

const datasets = await Promise.all(inputs.map(async (input) => (
  JSON.parse(await readFile(resolve(input), 'utf8'))
)));
for (const dataset of datasets) {
  if (dataset?.schema !== TOURNAMENT_TRAJECTORY_DATASET_SCHEMA
    || dataset.version !== 1 || !Array.isArray(dataset.rows)) {
    throw new TypeError('unsupported tournament trajectory dataset');
  }
}
const [first] = datasets;
if (datasets.some((dataset) => dataset.behavior !== first.behavior)) {
  throw new RangeError('trajectory datasets must share behavior provenance');
}
if (!allowProvenanceUnion && datasets.some((dataset) => (
  dataset.secretId !== first.secretId
  || dataset.sourceNamespaceSha256 !== first.sourceNamespaceSha256
))) {
  throw new RangeError('trajectory datasets must share secret, namespace and behavior provenance');
}
if (allowProvenanceUnion) {
  const claimedGroups = new Set();
  for (const dataset of datasets) {
    const groups = new Set(dataset.rows.map((row) => row.sourceGroup));
    if (groups.size !== Number(dataset.sourceGroups)) {
      throw new RangeError('trajectory dataset sourceGroups metadata does not match its rows');
    }
    for (const group of groups) {
      if (claimedGroups.has(group)) {
        throw new RangeError('provenance union requires disjoint sourceGroup sets');
      }
      claimedGroups.add(group);
    }
  }
}
const rows = datasets.flatMap((dataset) => dataset.rows)
  .sort((left, right) => left.rowId.localeCompare(right.rowId));
if (new Set(rows.map((row) => row.rowId)).size !== rows.length) {
  throw new RangeError('trajectory datasets contain duplicate row IDs');
}
const distinctProvenance = (singularField, pluralField) => [...new Set(datasets.flatMap(
  (dataset) => Array.isArray(dataset[pluralField])
    ? dataset[pluralField]
    : [dataset[singularField]],
))].sort();
const sourceSecretIds = distinctProvenance('secretId', 'sourceSecretIds');
const sourceNamespaceSha256s = distinctProvenance(
  'sourceNamespaceSha256', 'sourceNamespaceSha256s',
);
const compositeId = (kind, ids) => createHash('sha256')
  .update(`${kind}\n${ids.join('\n')}`)
  .digest('hex');
const artifact = {
  schema: TOURNAMENT_TRAJECTORY_DATASET_SCHEMA,
  version: 1,
  secretId: allowProvenanceUnion
    ? compositeId('qyj-provenance-union-secret-v1', sourceSecretIds)
    : first.secretId,
  sourceNamespaceSha256: allowProvenanceUnion
    ? compositeId('qyj-provenance-union-namespace-v1', sourceNamespaceSha256s)
    : first.sourceNamespaceSha256,
  tables: [...new Set(datasets.flatMap((dataset) => dataset.tables))].sort((a, b) => a - b),
  sourceGroups: new Set(rows.map((row) => row.sourceGroup)).size,
  matches: datasets.reduce((sum, dataset) => sum + Number(dataset.matches || 0), 0),
  behavior: first.behavior,
  ...(allowProvenanceUnion ? {
    provenanceUnion: true,
    sourceSecretIds,
    sourceNamespaceSha256s,
  } : {}),
  rows,
};
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(`saved=${destination} rows=${rows.length} groups=${artifact.sourceGroups}`);
