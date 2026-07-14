import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  blueprintBackoffKeys,
  buildBlueprintInfoSetKey,
} from '../js/game/blueprint-policy.js';
import {
  addBlueprintBackoffInfosets,
  summarizeBlueprintCoverage,
} from '../training/blueprint/curriculum.js';
import {
  buildBlueprintReachSupport,
  evaluateBlueprintHeldoutCoverage,
} from '../training/blueprint/coverage.js';
import {
  ExactInfosetReachProfiler,
  buildExactInfosetTrainingSnapshot,
  exactInfosetProfileSecretId,
  exactInfosetProfileSourceGroup,
} from '../training/blueprint/target-profile.js';
import {
  QyjAbstractHoldemGame,
  abstractObservation,
} from '../training/blueprint/qyj-abstract-game.js';
import { SerializableRng } from '../training/blueprint/rng.js';

const secret = 'blueprint-coverage-test-secret-with-at-least-32-bytes';
const secretId = exactInfosetProfileSecretId(secret);
const game = new QyjAbstractHoldemGame({
  tableSize: 2,
  round: 5,
  maxRaisesPerStreet: 1,
});
const state = game.createInitialState(new SerializableRng('coverage-root'));
const observation = abstractObservation(state, state.actingSeat);
const snapshot = buildExactInfosetTrainingSnapshot(observation);
const baseKey = buildBlueprintInfoSetKey(observation, { maxRaisesPerStreet: 1 });

function field(key, name, value) {
  const pattern = new RegExp(`(\\|${name}=)[^|]+`);
  assert(pattern.test(key), `fixture key must contain ${name}`);
  return key.replace(pattern, `$1${encodeURIComponent(value)}`);
}

function variant(tableSize, ip, closes) {
  return field(field(field(baseKey, 'n', tableSize), 'ip', ip), 'cl', closes);
}

function profileFor({ tableSize, keys, prefix, repeats }) {
  const profiler = new ExactInfosetReachProfiler({
    top: 100,
    variantsPerKey: 1,
    sourceGroupSecretId: secretId,
  });
  keys.forEach((exactKey, index) => {
    const sourceGroup = exactInfosetProfileSourceGroup(secret, `${prefix}-${index}`);
    for (let count = 0; count < repeats; count++) {
      profiler.observe({
        exactKey,
        strategy: 'qyz',
        street: observation.street,
        trainingSnapshot: snapshot,
        actionKey: 'call',
        sourceGroup,
      });
    }
  });
  return profiler.finalize({
    tableSize,
    skillsEnabled: false,
    maxRaisesPerStreet: 1,
    strategies: ['qyz'],
    matches: repeats,
    fullScheduleMatches: repeats,
  });
}

function hashed(profile) {
  return {
    profile,
    sha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
  };
}

const sourceKeysByTable = {
  6: [variant(6, 0, 0), variant(6, 1, 0), variant(6, 0, 1)],
  9: [variant(9, 0, 0), variant(9, 1, 0), variant(9, 0, 1)],
};
const heldoutKeysByTable = {
  6: variant(6, 1, 1),
  9: variant(9, 1, 1),
};
const trainingProfiles = [6, 9].map((tableSize) => hashed(profileFor({
  tableSize,
  keys: sourceKeysByTable[tableSize],
  prefix: `training-${tableSize}`,
  repeats: 2,
})));
const heldoutProfiles = [6, 9].map((tableSize) => hashed(profileFor({
  tableSize,
  keys: [heldoutKeysByTable[tableSize]],
  prefix: `heldout-${tableSize}`,
  repeats: 150,
})));

const exactSource = {
  schema: BLUEPRINT_SCHEMA,
  version: BLUEPRINT_VERSION,
  metadata: {
    abstraction: BLUEPRINT_ABSTRACTION,
    advantageGuard: { enabled: false },
  },
  blendWeight: 0.25,
  infosets: Object.fromEntries(Object.values(sourceKeysByTable).flat().map((key) => [
    key,
    { strategy: { call: 1 }, visits: 100 },
  ])),
};
const published = structuredClone(exactSource);
const reachSupport = buildBlueprintReachSupport(trainingProfiles);
assert.equal(reachSupport.promotionEligible, true);
addBlueprintBackoffInfosets(published, {
  minExactVisits: 100,
  minBackoffVisits: 200,
  minBackoffRoots: 2,
  minPopulationRoots: 3,
  minReachDecisions: 6,
  minReachGroups: 2,
  reachSupport,
});
published.metadata.publication = {
  ...published.metadata.publication,
  exactOnly: false,
  backoffPublished: true,
};
published.metadata.coverage = summarizeBlueprintCoverage(published);

const populationNodes = Object.entries(published.infosets)
  .filter(([key]) => key.includes('|bk=population|'));
assert.equal(populationNodes.length, 2,
  'one conservative population node must be published for each table size');
for (const [, node] of populationNodes) {
  assert.equal(node.distinctSourceExactRoots, 3);
  assert.equal(node.sourceReachDecisions, 6);
  assert.equal(node.sourceReachGroups, 3);
}
assert.equal(published.metadata.publication.sourceExactRootCount, 6);
assert.equal(published.metadata.publication.sourceReachGroupCount, 6);
assert.equal(published.metadata.publication.reachEvidenceAvailable, true);

const reportOptions = {
  checkpoint: published,
  sourceCheckpoint: exactSource,
  profileSources: heldoutProfiles,
  requiredTableSizes: [6, 9],
  minCoverage: 0.25,
  minDecisionsPerTable: 100,
};
const report = evaluateBlueprintHeldoutCoverage(reportOptions);
assert.deepEqual(evaluateBlueprintHeldoutCoverage(reportOptions), report,
  'held-out coverage must be byte-stable for the same artifacts');
assert.equal(report.gate.passed, true);
assert.equal(report.gate.promotable, true);
assert.equal(report.byTable['6'].coverage, 1);
assert.equal(report.byTable['9'].coverage, 1);
assert.equal(report.overall.levelCounts.population, 300);
assert.equal(report.source.excludedTrainingDecisions, 0);

const overlapping = evaluateBlueprintHeldoutCoverage({
  ...reportOptions,
  profileSources: trainingProfiles,
  minDecisionsPerTable: 1,
});
assert.equal(overlapping.gate.passed, false);
assert(overlapping.gate.blockers.includes(
  'heldout-profile-overlaps-publication-reach-evidence',
));
assert(overlapping.gate.blockers.includes('heldout-source-groups-overlap-publication'));

const missingNine = structuredClone(published);
delete missingNine.infosets[blueprintBackoffKeys(heldoutKeysByTable[9]).at(-1)];
const tableGate = evaluateBlueprintHeldoutCoverage({ ...reportOptions, checkpoint: missingNine });
assert.equal(tableGate.gate.passed, false);
assert.equal(tableGate.byTable['6'].coverage, 1);
assert.equal(tableGate.byTable['9'].coverage, 0);
assert(tableGate.gate.blockers.includes('table-9-coverage-below-threshold'),
  'aggregate six-seat coverage must never hide a failing nine-seat table');

const oneRoot = structuredClone(exactSource);
oneRoot.infosets = {
  [sourceKeysByTable[6][0]]: { strategy: { call: 1 }, visits: 10_000 },
};
addBlueprintBackoffInfosets(oneRoot, {
  minExactVisits: 1,
  minBackoffVisits: 1,
  minBackoffRoots: 2,
  minPopulationRoots: 3,
});
assert(Object.keys(oneRoot.infosets).every((key) => !key.includes('|bk=')),
  'arbitrarily many correlated visits from one exact root cannot publish a backoff');

console.log('blueprint held-out coverage tests passed: V2 group-disjoint 6/9 gates, population shadow support and visits-only rejection');
