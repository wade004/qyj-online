#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
for (const flag of ['--successors', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const source = JSON.parse(fs.readFileSync(path.resolve(value('--successors')), 'utf8'));
if (source?.schema !== 'qyj-residual-option-successors-v1' || Number(source?.version) !== 1) {
  throw new TypeError('unsupported successor artifact');
}
const grouped = new Map();
for (const row of source.rows || []) {
  const identity = `${row.sourceGroup}\u0000${row.successorInformationSetKey}`;
  let entry = grouped.get(identity);
  if (!entry) {
    entry = {
      informationSetKey: row.successorInformationSetKey,
      sourceGroup: row.sourceGroup,
      reachWeight: 0,
      sums: Object.fromEntries(Object.keys(row.baseStrategy).map((action) => [action, 0])),
    };
    grouped.set(identity, entry);
  }
  entry.reachWeight += row.attempts;
  for (const action of Object.keys(entry.sums)) {
    entry.sums[action] += Number(row.baseStrategy[action]) * row.attempts;
  }
}
const artifact = {
  schema: 'qyj-compact-residual-base-rows-v1',
  version: 1,
  profileSchema: 'qyj-exact-infoset-reach-profile-v2',
  profileVersion: 2,
  sourceGroupSecretId: source.sourceGroupSecretId,
  profileSources: source.profileSources,
  rows: [...grouped.values()].sort((left, right) => (
    left.sourceGroup.localeCompare(right.sourceGroup)
    || left.informationSetKey.localeCompare(right.informationSetKey)
  )).map((entry) => ({
    informationSetKey: entry.informationSetKey,
    baseStrategy: Object.fromEntries(Object.entries(entry.sums).map(([action, sum]) => [
      action, sum / entry.reachWeight,
    ])),
    sourceGroup: entry.sourceGroup,
    reachWeight: entry.reachWeight,
  })),
};
if (!artifact.rows.length) throw new RangeError('successor artifact contains no base rows');
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, rows: artifact.rows.length }));
