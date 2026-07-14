import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'qyj-provenance-merge-'));
const script = resolve('training/merge-tournament-policy-trajectories.mjs');
const dataset = (secretId, namespace, group, rowId) => ({
  schema: 'qyj-tournament-trajectory-dataset-v1',
  version: 1,
  secretId,
  sourceNamespaceSha256: namespace,
  tables: [6],
  sourceGroups: 1,
  matches: 1,
  behavior: 'qyz-explorer',
  rows: [{ rowId, sourceGroup: group }],
});
const run = (...args) => spawnSync(process.execPath, [script, ...args], {
  cwd: process.cwd(), encoding: 'utf8',
});

try {
  const first = join(root, 'first.json');
  const second = join(root, 'second.json');
  const overlap = join(root, 'overlap.json');
  const output = join(root, 'union.json');
  writeFileSync(first, JSON.stringify(dataset('secret-a', 'namespace-a', 'group-a', 'row-a')));
  writeFileSync(second, JSON.stringify(dataset('secret-b', 'namespace-b', 'group-b', 'row-b')));
  writeFileSync(overlap, JSON.stringify(dataset('secret-c', 'namespace-c', 'group-a', 'row-c')));

  const strict = run('--inputs', `${first},${second}`, '--output', output);
  assert.notEqual(strict.status, 0, 'strict merge must reject different provenance');

  const union = run(
    '--inputs', `${first},${second}`, '--output', output, '--allow-provenance-union',
  );
  assert.equal(union.status, 0, union.stderr);
  const artifact = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(artifact.provenanceUnion, true);
  assert.equal(artifact.sourceGroups, 2);
  assert.deepEqual(artifact.sourceSecretIds, ['secret-a', 'secret-b']);
  assert.deepEqual(artifact.sourceNamespaceSha256s, ['namespace-a', 'namespace-b']);
  assert.equal(artifact.rows.length, 2);

  const collision = run(
    '--inputs', `${first},${overlap}`, '--output', output, '--allow-provenance-union',
  );
  assert.notEqual(collision.status, 0, 'union merge must reject overlapping source groups');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('tournament provenance merge tests passed');
