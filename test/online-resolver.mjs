import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { lookupBlueprintDistribution } from '../js/game/blueprint-policy.js';
import {
  buildOnlineResolverTarget,
  solveOnlineResolverTarget,
} from '../training/eval/online-resolver.mjs';
import { compileTournamentValueModel } from '../training/tournament-value/model.js';

const modelText = fs.readFileSync('training/checkpoints/qyj-tv-v4-formal.json', 'utf8');
const reportText = fs.readFileSync(
  'training/checkpoints/qyj-tv-v4-formal-quality.json', 'utf8',
);
const artifact = JSON.parse(modelText);
const report = JSON.parse(reportText);
assert.equal(report.promotion.passed, true);
const source = {
  schema: artifact.schema,
  version: artifact.version,
  sha256: createHash('sha256').update(modelText).digest('hex'),
  qualityReportSha256: createHash('sha256').update(reportText).digest('hex'),
  datasetSha256: report.dataset.sha256,
};
assert.equal(source.sha256, report.model.sha256);

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => (
  candidate.trainingSnapshot?.tournament != null
));
assert(entry, 'formal resolver fixture requires a tournament-aware reached root');
const saved = entry.trainingSnapshot;
const players = Array.from({ length: saved.publicSeatCapacity + 1 }, () => null);
for (const player of saved.tournament.players) {
  players[player.idx] = {
    ...player,
    ...(saved.players.find((candidate) => candidate.idx === player.idx) || {}),
  };
}
const liveObservation = {
  ...saved,
  players,
  self: { ...players[saved.observerIdx], hole: saved.selfHole },
};
delete liveObservation.selfHole;
delete liveObservation.tournament;
liveObservation.seatCount = saved.publicSeatCapacity;
const rebuilt = buildOnlineResolverTarget(liveObservation, {
  maxRaisesPerStreet: profile.collection.maxRaisesPerStreet,
});
assert.equal(rebuilt.targetKey, entry.exactKey,
  'live observation and reach profile must share one exact abstraction');
assert.equal(Object.hasOwn(rebuilt.snapshot, 'observerIdx'), false,
  'target snapshot must not duplicate the actor field');

const model = compileTournamentValueModel(artifact);
const options = {
  tournamentValueModel: model,
  tournamentValueSource: source,
  tournamentValueModelText: modelText,
  tournamentValueReportText: reportText,
  simulationBudget: 2,
  validationClusterCount: 2,
  seedNamespace: 'online-resolver-self-test',
  maxRaisesPerStreet: profile.collection.maxRaisesPerStreet,
};
const first = solveOnlineResolverTarget(rebuilt, options);
assert.equal(first.diagnostics.accepted, true);
assert.equal(first.diagnostics.rootVisits, 2);
assert(first.diagnostics.utilitySamples > 0);
assert.equal(first.checkpoint.metadata.onlineResolver.deterministicSimulationBudget, 2);
assert.equal(first.checkpoint.metadata.tournamentValueSource.sha256, source.sha256);
assert.equal(first.diagnostics.validationClusterCount, 2);
const root = lookupBlueprintDistribution(first.checkpoint, rebuilt.targetKey);
assert(root && root.visits === 2 && root.strategy.length >= 2,
  'ephemeral checkpoint must publish exactly one genuinely visited root');

const second = solveOnlineResolverTarget(rebuilt, options);
assert.deepEqual(
  second.checkpoint.metadata,
  first.checkpoint.metadata,
  'fixed simulation budget and namespace must reproduce checkpoint metadata',
);
assert.deepEqual(
  lookupBlueprintDistribution(second.checkpoint, rebuilt.targetKey),
  root,
  'fixed public root and seed must reproduce the solved action distribution',
);

assert.throws(() => solveOnlineResolverTarget(rebuilt, {
  ...options,
  tournamentValueSource: { ...source, sha256: 'not-a-digest' },
}), /SHA-256/, 'resolver must fail closed on invalid model provenance');

console.log('online resolver tests passed: public root, promoted value binding, deterministic budget.');
