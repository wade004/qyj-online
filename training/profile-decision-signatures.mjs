#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, createHmac } from 'node:crypto';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import { buildSeatAssignments, createLineup, runMatch } from './eval/league.mjs';
import { deriveSeed } from './eval/rng.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const seedCount = Number(value('--seeds', 8));
const namespace = String(value('--seed-namespace', 'qyj-decision-signatures-v1'));
const output = path.resolve(value('--output', 'training/artifacts/decision-signatures.json'));
const secretName = value('--cluster-secret');
const targetStrategy = String(value('--target-strategy', 'qyz'));
if (![6, 9].includes(tableSize) || !Number.isSafeInteger(seedCount) || seedCount < 2
  || !secretName || !process.env[secretName] || Buffer.byteLength(process.env[secretName]) < 32) {
  throw new RangeError('decision profiling requires table 6/9, seeds >=2 and 32-byte secret');
}
const defaultLineup = tableSize === 6
  ? ['qyz', 'qyz-tight', 'qyz-aggressive', 'calling-station', 'random-legal', 'qyz-loose']
  : ['qyz', 'qyz-tight', 'qyz-aggressive', 'calling-station', 'random-legal',
    'check-fold', 'qyz-loose', 'qyz-bluffer', 'calling-station'];
const lineup = createLineup(String(value('--lineup', defaultLineup.join(','))), tableSize);
const assignments = buildSeatAssignments(lineup, { rotations: 'full', mirror: true });
const target = lineup.find((entry) => entry.strategy === targetStrategy);
if (!target) throw new RangeError(`target strategy ${targetStrategy} is not present in lineup`);
const defaultOrder = tableSize === 6 ? ['s', 'p', 'ip'] : ['s', 'n', 'p', 'ip', 'cl'];
const order = String(value('--features', defaultOrder.join(','))).split(',')
  .map((feature) => feature.trim()).filter(Boolean);
const records = new Map();
for (let seedIndex = 0; seedIndex < seedCount; seedIndex++) {
  const cluster = `${namespace}:${seedIndex + 1}`;
  const clusterId = `dc_${createHmac('sha256', process.env[secretName]).update(cluster).digest('hex')}`;
  const dealSeed = deriveSeed(namespace, 'deal', seedIndex);
  for (const assignment of assignments) {
    runMatch({
      assignment, seed: dealSeed, seedGroup: cluster,
      onDecisionTrace(row) {
        if (row.entryId !== target.id) return;
        const encoded = compactResidualFeatures(row.informationSetKey);
        if (!encoded) return;
        const signature = {
          mask: encoded.mask,
          features: Object.fromEntries(order.map((feature) => [feature, encoded.features[feature]])),
          baselineActionKey: row.actionKey,
          legalActionKeys: row.legalActionKeys,
        };
        const id = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
        const record = records.get(id) || {
          ...signature,
          clusters: new Map(), samples: 0, policySamples: 0,
          aggressiveMarginSum: 0, aggressiveMarginMin: Infinity, aggressiveMarginMax: -Infinity,
          selectedAggressive: 0,
          learnedTournamentSamples: 0, learnedTournamentAccepted: 0,
          learnedTournamentRiskSum: 0, learnedTournamentRiskMin: Infinity,
          learnedTournamentRiskMax: -Infinity, learnedTournamentRejections: {},
        };
        record.samples++;
        const aggressive = row.policyCandidates.filter((candidate) =>
          candidate.actionKey === 'allin' || candidate.actionKey.startsWith('raise:'));
        const passive = row.policyCandidates.filter((candidate) =>
          candidate.actionKey !== 'allin' && !candidate.actionKey.startsWith('raise:'));
        if (aggressive.length && passive.length) {
          const margin = (Math.max(...aggressive.map((candidate) => candidate.ev))
            - Math.max(...passive.map((candidate) => candidate.ev))) / Math.max(1, row.pot);
          record.policySamples++;
          record.aggressiveMarginSum += margin;
          record.aggressiveMarginMin = Math.min(record.aggressiveMarginMin, margin);
          record.aggressiveMarginMax = Math.max(record.aggressiveMarginMax, margin);
        }
        if (row.actionKey === 'allin' || row.actionKey.startsWith('raise:')) {
          record.selectedAggressive++;
        }
        if (row.learnedTournamentValue) {
          record.learnedTournamentSamples++;
          if (row.learnedTournamentValue.accepted) {
            const risk = Number(row.learnedTournamentValue.risk) || 0;
            record.learnedTournamentAccepted++;
            record.learnedTournamentRiskSum += risk;
            record.learnedTournamentRiskMin = Math.min(record.learnedTournamentRiskMin, risk);
            record.learnedTournamentRiskMax = Math.max(record.learnedTournamentRiskMax, risk);
          } else {
            const reason = String(row.learnedTournamentValue.reason || 'unknown');
            record.learnedTournamentRejections[reason]
              = (record.learnedTournamentRejections[reason] || 0) + 1;
          }
        }
        record.clusters.set(clusterId, (record.clusters.get(clusterId) || 0) + 1);
        records.set(id, record);
      },
    });
  }
}
const serialized = Object.fromEntries([...records].sort().map(([id, record]) => [id, {
  mask: record.mask,
  features: record.features,
  baselineActionKey: record.baselineActionKey,
  legalActionKeys: record.legalActionKeys,
  samples: record.samples,
  independentClusterCount: record.clusters.size,
  maxSamplesPerCluster: Math.max(...record.clusters.values()),
  policySamples: record.policySamples,
  meanNormalizedAggressiveMargin: record.policySamples
    ? record.aggressiveMarginSum / record.policySamples : null,
  minNormalizedAggressiveMargin: Number.isFinite(record.aggressiveMarginMin)
    ? record.aggressiveMarginMin : null,
  maxNormalizedAggressiveMargin: Number.isFinite(record.aggressiveMarginMax)
    ? record.aggressiveMarginMax : null,
  selectedAggressive: record.selectedAggressive,
  learnedTournamentSamples: record.learnedTournamentSamples,
  learnedTournamentAccepted: record.learnedTournamentAccepted,
  meanLearnedTournamentRisk: record.learnedTournamentAccepted
    ? record.learnedTournamentRiskSum / record.learnedTournamentAccepted : null,
  minLearnedTournamentRisk: Number.isFinite(record.learnedTournamentRiskMin)
    ? record.learnedTournamentRiskMin : null,
  maxLearnedTournamentRisk: Number.isFinite(record.learnedTournamentRiskMax)
    ? record.learnedTournamentRiskMax : null,
  learnedTournamentRejections: record.learnedTournamentRejections,
}]));
const artifact = {
  schema: 'qyj-decision-signature-profile-v1', version: 1,
  mode: 'offline-evaluation-only', tableSize, featureOrder: order,
  targetStrategy,
  seedClusters: seedCount, assignments: assignments.length,
  sourceGroupSecretId: `ds_${createHash('sha256').update(process.env[secretName]).digest('hex')}`,
  records: serialized,
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, signatures: Object.keys(serialized).length,
  samples: Object.values(serialized).reduce((sum, record) => sum + record.samples, 0) }));
