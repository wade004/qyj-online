#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { evaluateFrozenJointContinuationOption } from './blueprint/frozen-calibration.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
for (const flag of ['--checkpoint', '--profile', '--target-dataset', '--option-selector',
  '--tournament-model', '--tournament-report', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const secretEnv = value('--cluster-secret');
if (!secretEnv || !process.env[secretEnv]) {
  throw new RangeError('--cluster-secret must name a populated environment variable');
}
const readJson = (flag) => JSON.parse(fs.readFileSync(path.resolve(value(flag)), 'utf8'));
const checkpoint = readJson('--checkpoint');
const profile = readJson('--profile');
const dataset = readJson('--target-dataset');
const optionSelector = readJson('--option-selector');
const selectorRoots = new Set((optionSelector.roots || []).map((root) => root.rootSha256));
const eligibilityPath = value('--eligibility-calibration');
const eligibleKeys = eligibilityPath
  ? new Set(Object.entries(JSON.parse(fs.readFileSync(path.resolve(eligibilityPath), 'utf8')).records || {})
    .filter(([, record]) => Number(record.controlledDecisions) > 0)
    .map(([key]) => key))
  : null;
const weights = new Map();
for (const row of dataset.rows || []) weights.set(
  row.informationSetKey,
  (weights.get(row.informationSetKey) || 0) + Number(row.reachWeight || 0),
);
const maskOf = (key) => {
  const match = /(?:^|\|)lm=([^|]+)/.exec(String(key));
  return match ? decodeURIComponent(match[1]) : 'unknown';
};
const top = Number(value('--top', 64));
if (!Number.isSafeInteger(top) || top < 1 || top > 1000) {
  throw new RangeError('--top must be an integer in 1..1000');
}
const strata = new Map();
for (const entry of profile.entries.filter((candidate) => (
  weights.has(candidate.exactKey)
  && selectorRoots.has(createHash('sha256').update(candidate.exactKey).digest('hex'))
  && (!eligibleKeys || eligibleKeys.has(candidate.exactKey))
))) {
  const stratum = `${Object.keys(entry.streets || {})[0] || 'unknown'}|${maskOf(entry.exactKey)}`;
  const list = strata.get(stratum) || [];
  list.push(entry);
  strata.set(stratum, list);
}
for (const list of strata.values()) list.sort((left, right) => (
  weights.get(right.exactKey) - weights.get(left.exactKey)
  || String(left.exactKey).localeCompare(String(right.exactKey))
));
const selected = [];
const ordered = [...strata].sort(([left], [right]) => left.localeCompare(right));
for (let depth = 0; selected.length < top; depth++) {
  let added = false;
  for (const [, list] of ordered) {
    if (!list[depth]) continue;
    selected.push(list[depth]);
    added = true;
    if (selected.length >= top) break;
  }
  if (!added) break;
}
const targets = selected.flatMap((entry) => (
  (entry.trainingSnapshots || [entry.trainingSnapshot]).slice(0, 1).map((trainingSnapshot) => {
    const { observerIdx, ...snapshot } = trainingSnapshot;
    return { targetKey: entry.exactKey, actorIdx: observerIdx, snapshot };
  })
));
if (!targets.length) throw new RangeError('profile contains no reached exact roots');
const clusterCount = Number(value('--clusters', 16));
const rolloutsPerCluster = Number(value('--rollouts', 4));
const namespace = value('--seed-namespace', 'qyj-joint-continuation-option-v1');
const clusterSeeds = Array.from({ length: clusterCount }, (_, index) => `${namespace}:${index + 1}`);
const forbiddenSeedClusters = String(value('--forbidden-seeds', ''))
  .split(',').map((item) => item.trim()).filter(Boolean);
const common = {
  checkpoint,
  optionSelector,
  tournamentValueModelText: fs.readFileSync(path.resolve(value('--tournament-model')), 'utf8'),
  tournamentValueReportText: fs.readFileSync(path.resolve(value('--tournament-report')), 'utf8'),
  clusterSeeds,
  forbiddenSeedClusters,
  clusterIdSecret: process.env[secretEnv],
  rolloutsPerCluster,
};
const artifacts = [];
const failures = [];
for (const target of targets) {
  try {
    artifacts.push(evaluateFrozenJointContinuationOption(target, common));
  } catch (error) {
    failures.push({
      rootSha256: createHash('sha256').update(target.targetKey).digest('hex'),
      reason: String(error?.message || 'joint calibration failed').slice(0, 200),
    });
  }
}
if (!artifacts.length) throw new RangeError('all selected joint option roots failed calibration');
const artifact = {
  ...artifacts[0],
  records: Object.assign({}, ...artifacts.map((candidate) => candidate.records)),
};
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
const records = Object.values(artifact.records);
console.log(JSON.stringify({
  output,
  selectedRoots: targets.length,
  calibratedRoots: records.length,
  failedRoots: failures.length,
  failures,
  positiveRoots: records.filter((record) => record.lowerBound > 0).length,
  controlledDecisions: records.reduce((sum, record) => sum + record.controlledDecisions, 0),
  horizonReached: records.reduce((sum, record) => sum + record.horizonReached, 0),
  clusterCount,
  rolloutsPerCluster,
}));
