#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
for (const flag of ['--guidance-output', '--base-output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const guidancePaths = args.flatMap((arg, index) => arg === '--guidance' ? [args[index + 1]] : []);
const basePaths = args.flatMap((arg, index) => arg === '--base' ? [args[index + 1]] : []);
if (guidancePaths.length < 2 || guidancePaths.length !== basePaths.length) {
  throw new RangeError('provide matching repeated --guidance and --base inputs');
}
const read = (file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const guidances = guidancePaths.map(read);
const bases = basePaths.map(read);
const firstGuidance = guidances[0];
for (const guidance of guidances) {
  if (guidance.schema !== firstGuidance.schema || guidance.mode !== firstGuidance.mode
    || guidance.basePolicyContract !== firstGuidance.basePolicyContract
    || guidance.baseStyleKey !== firstGuidance.baseStyleKey
    || guidance.tournamentValueModelSha256 !== firstGuidance.tournamentValueModelSha256
    || guidance.tournamentValueReportSha256 !== firstGuidance.tournamentValueReportSha256) {
    throw new RangeError('successor guidances use incompatible contracts');
  }
}
const records = {};
for (const guidance of guidances) {
  for (const [key, record] of Object.entries(guidance.records || {})) {
    if (records[key]) throw new RangeError('successor guidances overlap exact roots');
    records[key] = record;
  }
}
const mergedGuidance = {
  ...firstGuidance,
  calibrationSha256: createHash('sha256')
    .update(JSON.stringify(guidances.map((guidance) => guidance.calibrationSha256))).digest('hex'),
  records,
  summary: {
    calibratedRoots: Object.keys(records).length,
    actionableRoots: Object.values(records).filter((record) => record.actionableActions.length).length,
    actionableActions: Object.values(records).reduce(
      (sum, record) => sum + record.actionableActions.length, 0,
    ),
  },
  promotionEligible: false,
  promotionBlockers: ['cumulative-successor-coverage-below-formal-scale', 'shadow-only-schema-cannot-deploy'],
};
const secret = bases[0].sourceGroupSecretId;
const groups = new Set();
const identities = new Set();
for (const base of bases) {
  if (base.schema !== 'qyj-compact-residual-base-rows-v1'
    || base.sourceGroupSecretId !== secret) throw new RangeError('incompatible successor base rows');
  for (const source of base.profileSources || []) {
    for (const group of source.sourceGroups || []) {
      if (groups.has(group)) throw new RangeError('successor source groups overlap');
      groups.add(group);
    }
  }
  for (const row of base.rows || []) {
    const identity = `${row.sourceGroup}\u0000${row.informationSetKey}`;
    if (identities.has(identity)) throw new RangeError('successor base rows overlap');
    identities.add(identity);
  }
}
const mergedBase = {
  ...bases[0],
  profileSources: bases.flatMap((base) => base.profileSources),
  rows: bases.flatMap((base) => base.rows),
};
for (const [file, artifact] of [[value('--guidance-output'), mergedGuidance],
  [value('--base-output'), mergedBase]]) {
  const output = path.resolve(file);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({
  guidanceOutput: path.resolve(value('--guidance-output')),
  baseOutput: path.resolve(value('--base-output')),
  guidanceRoots: mergedGuidance.summary.calibratedRoots,
  actionableRoots: mergedGuidance.summary.actionableRoots,
  baseRows: mergedBase.rows.length,
  sourceGroups: groups.size,
}));
