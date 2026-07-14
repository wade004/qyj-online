#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createHmac } from 'node:crypto';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import {
  buildPromotionCrossoverLineup,
  buildSeatAssignments,
  createLineup,
  runMatch,
} from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';

export const ROLLOUT_INTERVENTION_DATASET_SCHEMA =
  'qyj-rollout-intervention-outcomes-v1';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 4));
const seedOffset = Number(value('--seed-offset', 0));
const targetsPerMatch = Number(value('--targets-per-match', 4));
const split = String(value('--split', 'training'));
const namespace = String(value('--seed-namespace', `qyj-v73-${split}-${tableSize}`));
const output = path.resolve(value(
  '--output', `training/artifacts/qyj-v73-interventions-${tableSize}-${split}.json`,
));
const resolverStrategyKey = String(value(
  '--resolver-strategy', 'online-resolver-v19-table-powered',
));
const includeGateRejections = String(
  value('--include-gate-rejections', 'false'),
) === 'true';
const promotionCrossoverBaseline = value('--promotion-crossover-baseline');
const secretName = value('--cluster-secret');
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !Number.isSafeInteger(seedOffset) || seedOffset < 0
  || !Number.isSafeInteger(targetsPerMatch) || targetsPerMatch < 1
  || !['training', 'calibration', 'test'].includes(split)
  || !secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError(
    'collection requires table 6/9, seeds >=2, a valid split and a 32-byte secret',
  );
}
const defaultLineup = tableSize === 6
  ? [resolverStrategyKey, 'qyz-tight', 'qyz-aggressive', 'calling-station',
    'random-legal', 'qyz-loose']
  : [resolverStrategyKey, 'qyz-tight', 'qyz-aggressive', 'calling-station',
    'random-legal', 'check-fold', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup(String(value('--lineup', defaultLineup.join(','))), tableSize);
const baseAssignments = buildSeatAssignments(lineup, {
  rotations: value('--rotations', 'full'),
  mirror: value('--mirror', 'true') !== 'false',
});
const crossedLineup = promotionCrossoverBaseline
  ? buildPromotionCrossoverLineup(lineup, {
    candidate: resolverStrategyKey,
    baseline: String(promotionCrossoverBaseline),
  }) : null;
const crossedAssignments = crossedLineup ? buildSeatAssignments(crossedLineup, {
  rotations: value('--rotations', 'full'),
  mirror: value('--mirror', 'true') !== 'false',
}).map((assignment) => Object.freeze({
  ...assignment,
  key: `${assignment.key}-candidate-baseline-swap`,
  promotionCrossover: true,
})) : [];
const assignments = Object.freeze([...baseAssignments, ...crossedAssignments]);
const targetEntry = lineup.find((entry) => entry.strategy === resolverStrategyKey);
if (!targetEntry) throw new RangeError('lineup requires the resolver strategy target');

const secret = process.env[secretName];
const sourceGroupSecretId = `ri_${createHash('sha256').update(secret).digest('hex')}`;
const finite = (input) => (Number.isFinite(Number(input)) ? Number(input) : null);
const records = [];
let changedDecisionCount = 0;
let resolverDecisionCount = 0;
let replayErrorCount = 0;
let completedMatches = 0;
let keptProposalCount = 0;
let rejectedProposalCount = 0;

for (let localSeedIndex = 0; localSeedIndex < seedCount; localSeedIndex++) {
  const seedIndex = seedOffset + localSeedIndex;
  const seedGroup = `${namespace}:${seedIndex + 1}`;
  const dealSeed = deriveSeed(namespace, 'deal', seedIndex);
  const clusterId = `ri_${createHmac('sha256', secret).update(seedGroup).digest('hex')}`;
  for (const assignment of assignments) {
    const trace = [];
    const candidateMatch = runMatch({
      assignment,
      seed: dealSeed,
      seedGroup,
      onDecisionTrace: (row) => trace.push(row),
    });
    const candidateResult = candidateMatch.results.find(
      (row) => row.entryId === targetEntry.id,
    );
    const targets = trace.flatMap((row) => {
      if (row.entryId !== targetEntry.id || !row.onlineResolver?.baseActionKey
        || !row.onlineResolver.rollout?.screen?.selected
        || !row.onlineResolver.rollout?.confirmation?.selected) return [];
      const gateRejected = includeGateRejections && (
        (row.onlineResolver.reason === 'cluster-causal-harm-predicted'
          && row.onlineResolver.causalHarmGate?.eligible === false)
        || row.onlineResolver.reason === 'confirmation-confidence-floor-not-cleared'
        || row.onlineResolver.reason === 'real-engine-calibrated-value-not-cleared'
        || row.onlineResolver.reason === 'real-engine-structural-risk-blocked'
      );
      const actionKey = gateRejected
        ? row.onlineResolver.proposedActionKey : row.onlineResolver.resolverActionKey;
      const kept = row.onlineResolver.accepted === true
        && row.onlineResolver.actionChanged === true;
      if ((!kept && !gateRejected) || !actionKey
        || actionKey === row.onlineResolver.baseActionKey
        || !row.legalActionKeys.includes(row.onlineResolver.baseActionKey)
        || !row.legalActionKeys.includes(actionKey)) return [];
      return [{ ...row, interventionActionKey: actionKey, gateDisposition: gateRejected
        ? 'rejected' : 'kept' }];
    });
    resolverDecisionCount += trace.filter((row) => row.entryId === targetEntry.id).length;
    changedDecisionCount += targets.length;
    keptProposalCount += targets.filter((target) => target.gateDisposition === 'kept').length;
    rejectedProposalCount += targets.filter(
      (target) => target.gateDisposition === 'rejected',
    ).length;
    targets.sort((left, right) => createHash('sha256').update(
      `${seedGroup}|${assignment.key}|${left.ordinal}|${left.informationSetKey}`,
    ).digest('hex').localeCompare(createHash('sha256').update(
      `${seedGroup}|${assignment.key}|${right.ordinal}|${right.informationSetKey}`,
    ).digest('hex')));
    for (const target of targets.slice(0, targetsPerMatch)) {
      const encoded = compactResidualFeatures(target.informationSetKey);
      if (!encoded) continue;
      try {
        const baseBranch = runMatch({
          assignment,
          seed: dealSeed,
          seedGroup,
          forcedDecision: {
            entryId: target.entryId,
            ordinal: target.ordinal,
            actionKey: target.onlineResolver.baseActionKey,
          },
        });
        const baseResult = baseBranch.results.find((row) => row.entryId === targetEntry.id);
        const proposalResult = target.gateDisposition === 'rejected'
          ? runMatch({
            assignment,
            seed: dealSeed,
            seedGroup,
            forcedDecision: {
              entryId: target.entryId,
              ordinal: target.ordinal,
              actionKey: target.interventionActionKey,
            },
          }).results.find((row) => row.entryId === targetEntry.id)
          : candidateResult;
        if (!proposalResult || !baseResult) throw new Error('target result missing');
        const screen = target.onlineResolver.rollout.screen;
        const confirmation = target.onlineResolver.rollout.confirmation;
        const publicSignature = {
          tableSize,
          street: target.street,
          mask: encoded.mask,
          features: encoded.features,
          baseActionKey: target.onlineResolver.baseActionKey,
          actionKey: target.interventionActionKey,
          pot: target.pot,
          screenLowerBound: finite(screen.selected?.lowerBound),
          confirmationLowerBound: finite(confirmation.selected?.lowerBound),
        };
        const sampleId = createHash('sha256').update(
          `${clusterId}|${assignment.key}|${target.ordinal}|${JSON.stringify(publicSignature)}`,
        ).digest('hex');
        records.push(Object.freeze({
          sampleId,
          clusterId,
          tableSize,
          street: target.street,
          mask: encoded.mask,
          features: encoded.features,
          baseActionKey: target.onlineResolver.baseActionKey,
          actionKey: target.interventionActionKey,
          gateDisposition: target.gateDisposition,
          gatePrediction: target.onlineResolver.causalHarmGate || null,
          valueCalibration: target.onlineResolver.realValueCalibration || null,
          pot: target.pot,
          screen: {
            clusterCount: screen.clusterCount,
            utilitySamples: screen.utilitySamples,
            mean: finite(screen.selected?.mean),
            lowerBound: finite(screen.selected?.lowerBound),
          },
          confirmation: {
            clusterCount: confirmation.clusterCount,
            utilitySamples: confirmation.utilitySamples,
            mean: finite(confirmation.selected?.mean),
            lowerBound: finite(confirmation.selected?.lowerBound),
          },
          outcome: {
            rankAdvantage: Number(baseResult.rank) - Number(proposalResult.rank),
            hpAdvantage: Number(proposalResult.hp) - Number(baseResult.hp),
          },
        }));
      } catch {
        replayErrorCount++;
      }
    }
    completedMatches++;
    if (completedMatches % Math.max(1, assignments.length) === 0) {
      console.error(JSON.stringify({
        split,
        tableSize,
        seed: seedIndex + 1,
        seedOffset,
        seeds: seedCount,
        records: records.length,
        replayErrorCount,
      }));
    }
  }
}

const artifact = {
  schema: ROLLOUT_INTERVENTION_DATASET_SCHEMA,
  version: 1,
  mode: 'offline-evaluation-only',
  split,
  tableSize,
  resolverStrategyKey,
  seedClusters: seedCount,
  seedOffset,
  assignments: assignments.length,
  changedDecisionCount,
  keptProposalCount,
  rejectedProposalCount,
  resolverDecisionCount,
  replayErrorCount,
  sourceGroupSecretId,
  records,
  promotionEligible: false,
  promotionBlockers: [
    'intervention-outcomes-are-model-development-evidence',
    'offline-evaluation-only',
  ],
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  output,
  split,
  tableSize,
  records: records.length,
  changedDecisionCount,
  keptProposalCount,
  rejectedProposalCount,
  resolverDecisionCount,
  replayErrorCount,
}));
