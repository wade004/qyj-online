#!/usr/bin/env node
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {
  attachFrozenExactRootCalibration,
  evaluateFrozenExactRootCalibration,
} from './blueprint/frozen-calibration.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const required = ['--checkpoint', '--profile', '--tournament-model', '--tournament-report', '--output'];
for (const flag of required) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const secretEnv = value('--cluster-secret');
if (!secretEnv || !process.env[secretEnv]) {
  throw new RangeError('--cluster-secret must name a populated environment variable');
}
const checkpoint = JSON.parse(fs.readFileSync(path.resolve(value('--checkpoint')), 'utf8'));
const profile = JSON.parse(fs.readFileSync(path.resolve(value('--profile')), 'utf8'));
function maskOf(key) {
  const match = /(?:^|\|)lm=([^|]+)/.exec(String(key));
  return match ? decodeURIComponent(match[1]) : 'unknown';
}

function selectEntries() {
  const targetKeyFile = value('--target-key-file');
  if (targetKeyFile) {
    const artifact = JSON.parse(fs.readFileSync(path.resolve(targetKeyFile), 'utf8'));
    if (artifact?.schema !== 'qyj-residual-option-successors-v1') {
      throw new TypeError('--target-key-file must be a successor artifact');
    }
    const keys = new Set((artifact.rows || []).map((row) => row.successorInformationSetKey));
    const top = Number(value('--top', keys.size));
    return profile.entries.filter((entry) => keys.has(entry.exactKey))
      .sort((left, right) => Number(right.count) - Number(left.count)
        || String(left.exactKey).localeCompare(String(right.exactKey)))
      .slice(0, top);
  }
  const targetDatasetPath = value('--target-dataset');
  if (targetDatasetPath) {
    const dataset = JSON.parse(fs.readFileSync(path.resolve(targetDatasetPath), 'utf8'));
    const weights = new Map();
    for (const row of dataset.rows || []) weights.set(
      row.informationSetKey,
      (weights.get(row.informationSetKey) || 0) + Number(row.reachWeight || 0),
    );
    const top = Number(value('--top', 16));
    const strata = new Map();
    for (const entry of profile.entries.filter((candidate) => weights.has(candidate.exactKey))) {
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
        if (list[depth]) {
          selected.push(list[depth]);
          added = true;
          if (selected.length >= top) break;
        }
      }
      if (!added) break;
    }
    return selected;
  }
  if (!args.includes('--counterfactual-roots')) {
    return profile.entries.filter((entry) => entry.checkpoint?.exactHits > 0);
  }
  const top = Number(value('--top', 12));
  const minCount = Number(value('--min-count', 1));
  if (!Number.isSafeInteger(top) || top < 1 || top > 1000) {
    throw new RangeError('--top must be an integer in 1..1000');
  }
  const strata = new Map();
  for (const entry of profile.entries.filter((candidate) => Number(candidate.count) >= minCount)) {
    const stratum = `${entry.streets ? Object.keys(entry.streets)[0] : 'unknown'}|${maskOf(entry.exactKey)}`;
    const list = strata.get(stratum) || [];
    list.push(entry);
    strata.set(stratum, list);
  }
  for (const list of strata.values()) list.sort((left, right) => (
    Number(right.count) - Number(left.count)
      || String(left.exactKey).localeCompare(String(right.exactKey))
  ));
  const selected = [];
  const ordered = [...strata].sort(([left], [right]) => left.localeCompare(right));
  for (let depth = 0; selected.length < top; depth++) {
    let added = false;
    for (const [, list] of ordered) {
      if (list[depth]) {
        selected.push(list[depth]);
        added = true;
        if (selected.length >= top) break;
      }
    }
    if (!added) break;
  }
  return selected;
}

const targets = selectEntries()
  .flatMap((entry) => (entry.trainingSnapshots || [entry.trainingSnapshot]).slice(0, 1).map((trainingSnapshot) => {
    const { observerIdx, ...snapshot } = trainingSnapshot;
    return { targetKey: entry.exactKey, actorIdx: observerIdx, snapshot };
  }));
if (!targets.length) throw new RangeError('profile contains no reached exact roots');
const clusterCount = Number(value('--clusters', 20));
const rolloutsPerCluster = Number(value('--rollouts', 4));
const namespace = value('--seed-namespace', 'qyj-residual-advantage-calibration-v1');
const clusterSeeds = Array.from({ length: clusterCount }, (_, index) => `${namespace}:${index + 1}`);
const forbiddenSeedClusters = String(value('--forbidden-seeds', ''))
  .split(',').map((item) => item.trim()).filter(Boolean);
const common = {
  checkpoint,
  tournamentValueModelText: fs.readFileSync(path.resolve(value('--tournament-model')), 'utf8'),
  tournamentValueReportText: fs.readFileSync(path.resolve(value('--tournament-report')), 'utf8'),
  clusterSeeds,
  forbiddenSeedClusters,
  clusterIdSecret: process.env[secretEnv],
  basePolicyContract: value('--base-policy-contract', 'qyj-range-ev-v1'),
  baseStyleKey: value('--base-style', 'tag'),
  rolloutsPerCluster,
  bootstrapIterations: Number(value('--bootstrap', 1000)),
  allowCounterfactualRoots: args.includes('--counterfactual-roots'),
};
const artifacts = [];
const failures = [];
for (const target of targets) {
  try {
    artifacts.push(evaluateFrozenExactRootCalibration(target, common));
  } catch (error) {
    failures.push({
      rootSha256: createHash('sha256').update(target.targetKey).digest('hex'),
      reason: String(error?.message || 'calibration failed').slice(0, 200),
    });
  }
}
if (!artifacts.length) {
  console.error(JSON.stringify({ selectedRoots: targets.length, failures }, null, 2));
  throw new RangeError('all selected counterfactual roots failed calibration');
}
const artifact = {
  ...artifacts[0],
  records: Object.assign({}, ...artifacts.map((candidate) => candidate.records)),
};
if (!args.includes('--counterfactual-roots')) {
  attachFrozenExactRootCalibration(checkpoint, artifact);
}
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  selectedRoots: targets.length,
  calibratedRoots: Object.keys(artifact.records).length,
  failedRoots: failures.length,
  failures,
  clusterCount,
  rolloutsPerCluster,
}));
