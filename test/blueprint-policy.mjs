import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  BLUEPRINT_ABSTRACTION,
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  actionFromBlueprintKey,
  actionToBlueprintKey,
  blendBlueprintPolicy,
  blueprintBackoffKeys,
  blueprintLegalContext,
  buildBlueprintInfoSetKey,
  compileBlueprintCheckpoint,
  frozenBlueprintPolicySha256,
  getBlueprintPolicyDiagnostics,
  legalizeBlueprintAction,
  loadBlueprintCheckpoint,
  lookupBlueprintDistribution,
} from '../js/game/blueprint-policy.js';
import {
  attachFrozenExactRootCalibration,
  buildFrozenExactRootCalibration,
} from '../training/blueprint/frozen-calibration.mjs';

function canonicalJsonForHash(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(typeof value === 'number' && Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForHash).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJsonForHash(value[key])}`
  )).join(',')}}`;
}

const legalActions = Object.freeze({
  toCall: 100,
  canCheck: false,
  callAmount: 100,
  allInAmount: 900,
  canRaise: true,
  canAllIn: true,
  tiers: Object.freeze([
    Object.freeze({ key: 'feint', name: 'small', increment: 120, cost: 220 }),
    Object.freeze({ key: 'strike', name: 'medium', increment: 220, cost: 320 }),
  ]),
});

const observation = Object.freeze({
  version: 1,
  observerIdx: 1,
  round: 3,
  street: 'preflop',
  dealerIdx: 3,
  handSeats: Object.freeze([1, 2, 3, 4, 5, 6]),
  activeSeats: Object.freeze([1, 2, 3, 4, 5, 6]),
  blinds: Object.freeze({ sb: 10, bb: 20 }),
  board: Object.freeze([]),
  self: Object.freeze({
    idx: 1,
    position: 'HJ',
    hp: 900,
    betStreet: 0,
    hole: Object.freeze([
      Object.freeze({ rank: 14, suit: 1 }),
      Object.freeze({ rank: 13, suit: 1 }),
    ]),
  }),
  players: Object.freeze([
    null,
    Object.freeze({ idx: 1, hp: 900, betStreet: 0, position: 'HJ' }),
    Object.freeze({ idx: 2, hp: 1200, betStreet: 100, position: 'CO' }),
    Object.freeze({ idx: 3, hp: 1000, betStreet: 0, position: 'BTN' }),
    Object.freeze({ idx: 4, hp: 1000, betStreet: 0, position: 'SB' }),
    Object.freeze({ idx: 5, hp: 1000, betStreet: 0, position: 'BB' }),
    Object.freeze({ idx: 6, hp: 1000, betStreet: 0, position: 'UTG' }),
  ]),
  betting: Object.freeze({ pot: 250, currentBet: 100, minRaiseIncrement: 100 }),
  legalActions,
  actionHistory: Object.freeze([
    Object.freeze({
      id: 1,
      actorIdx: 2,
      round: 3,
      street: 'preflop',
      type: 'raise',
      key: 'feint',
      amount: 100,
      potBefore: 150,
      position: 'CO',
      isAggressive: true,
      forced: false,
    }),
  ]),
});

const informationSetKey = buildBlueprintInfoSetKey(observation);
assert.match(informationSetKey, /^bp2\|s=preflop\|n=6\|a=5\|ao=0\|/);
assert.ok(informationSetKey.includes('h=AKs'), 'own private hand abstraction must enter the key');
assert.ok(informationSetKey.includes('x=P100LHN_F000NNN_T000NNN_R000NNN'),
  'public action history must use the fixed four-street summary');
assert.ok(informationSetKey.length < 512, 'v2 information keys must remain compact');

const zeroBasedRing = {
  ...observation,
  observerIdx: 0,
  dealerIdx: 0,
  handSeats: [0, 1, 2, 3, 4, 5],
  activeSeats: [0, 1, 2, 3, 4, 5],
  self: { ...observation.self, idx: 0, position: 'BTN' },
  players: Array.from({ length: 6 }, (_, idx) => ({
    idx, hp: 1000, betStreet: idx === 1 ? 100 : 0,
  })),
  actionHistory: [],
};
assert.ok(buildBlueprintInfoSetKey(zeroBasedRing).includes('|ip=1|'),
  'zero-based tables must count the highest seat instead of collapsing it onto seat zero');
const [
  historyBackoffKey,
  positionBackoffKey,
  strategicBackoffKey,
  populationBackoffKey,
] = blueprintBackoffKeys(informationSetKey);
assert.match(historyBackoffKey, /^bp2\|bk=history\|/);
assert.ok(historyBackoffKey.includes('|x=-'));
assert.match(positionBackoffKey, /^bp2\|bk=position\|/);
assert.ok(positionBackoffKey.includes('|p=middle|'),
  'position backoff must retain a stable strategic position group');
assert.match(strategicBackoffKey, /^bp2\|bk=strategic\|/);
assert.match(populationBackoffKey, /^bp2\|bk=population\|/);
for (const retained of [
  's', 'n', 'p', 'h', 'b', 'stk', 'spr', 'tc', 'r', 'lm', 'rr', 'jm',
]) {
  const pattern = new RegExp(`\\|${retained}=([^|]+)`);
  assert.equal(pattern.exec(populationBackoffKey)?.[1], pattern.exec(strategicBackoffKey)?.[1],
    `population backoff must retain ${retained}`);
}
assert(populationBackoffKey.includes('|a=multi|'),
  'population backoff must keep a coarse active-opponent boundary');
for (const pooled of ['ao', 'ip', 'cl', 'rc', 'x']) {
  assert(populationBackoffKey.includes(`|${pooled}=-`),
    `population backoff must audibly pool ${pooled}`);
}

// Hidden Engine-like fields and opponent holes are not part of the allow-listed key.
const contaminated = {
  ...observation,
  deck: [{ rank: 2, suit: 1 }],
  futureBoard: [{ rank: 14, suit: 4 }],
  players: observation.players.map((player) => player && ({
    ...player,
    hole: [{ rank: 14, suit: 4 }, { rank: 14, suit: 3 }],
  })),
};
assert.equal(buildBlueprintInfoSetKey(contaminated), informationSetKey,
  'blueprint keys must never consume hidden opponent/deck/runout state');
assert.notEqual(buildBlueprintInfoSetKey({
  ...observation,
  self: { ...observation.self, hole: [{ rank: 7, suit: 1 }, { rank: 2, suit: 2 }] },
}), informationSetKey, 'the observer own cards must distinguish information sets');

assert.deepEqual(blueprintLegalContext(observation, legalActions), {
  mask: '5d',
  raiseRight: 1,
  jamKind: 'f',
  canonicalActionKeys: ['allin', 'call', 'fold', 'raise:feint', 'raise:strike'],
});
assert.deepEqual(blueprintLegalContext({
  ...observation,
  betting: { ...observation.betting, minRaiseIncrement: 100 },
}, {
  toCall: 100, callAmount: 100, allInAmount: 150,
  canCheck: false, canRaise: true, canAllIn: true, tiers: [],
}), {
  mask: '45', raiseRight: 0, jamKind: 'u',
  canonicalActionKeys: ['allin', 'call', 'fold'],
}, 'jam-only rights are carried by lm+jm rather than producer-specific raw canRaise');
assert.deepEqual(blueprintLegalContext(observation, {
  toCall: 100, callAmount: 100, allInAmount: 100,
  canCheck: false, canRaise: false, canAllIn: true, tiers: [],
}), {
  mask: '5', raiseRight: 0, jamKind: 'c', canonicalActionKeys: ['call', 'fold'],
}, 'call-for-all-in must not set the aggressive all-in action bit');
const capReachedObservation = {
  ...observation,
  betting: { ...observation.betting, streetRaiseCount: 1 },
};
assert.deepEqual(blueprintLegalContext(capReachedObservation, legalActions, {
  maxRaisesPerStreet: 1,
}), {
  mask: '5', raiseRight: 0, jamKind: 'n', canonicalActionKeys: ['call', 'fold'],
}, 'a checkpoint raise cap must be an explicit shared action abstraction');
const capPrunedOptions = {
  ...legalActions, canRaise: false, canAllIn: false, tiers: [],
};
const cappedRuntimeKey = buildBlueprintInfoSetKey(capReachedObservation, {
  opts: legalActions, maxRaisesPerStreet: 1,
});
const cappedTrainerKey = buildBlueprintInfoSetKey({
  ...capReachedObservation, legalActions: capPrunedOptions,
}, {
  opts: capPrunedOptions, maxRaisesPerStreet: 1,
});
assert.equal(cappedRuntimeKey, cappedTrainerKey,
  'runtime live options and trainer-pruned options must share a capped key');
assert.notEqual(buildBlueprintInfoSetKey(observation), buildBlueprintInfoSetKey({
  ...observation,
  legalActions: { ...legalActions, canRaise: false, canAllIn: false, tiers: [] },
}), 'different legal-action/raise-right states must never share an information set');

const oldRoundNoise = {
  ...observation,
  actionHistory: [
    { ...observation.actionHistory[0], round: 2, id: 999, actorIdx: 5 },
    ...observation.actionHistory,
  ],
};
assert.equal(buildBlueprintInfoSetKey(oldRoundNoise), informationSetKey,
  'prior-round transcripts and event ids must not expand the current information set');
const saturatedRaises = (count) => ({
  ...observation,
  actionHistory: Array.from({ length: count }, (_, index) => ({
    ...observation.actionHistory[0],
    id: index + 1,
    actorIdx: 2,
    amount: 100,
    potBefore: 200,
  })),
});
assert.equal(buildBlueprintInfoSetKey(saturatedRaises(3)), buildBlueprintInfoSetKey(saturatedRaises(7)),
  'history counters above two must saturate instead of creating new transcript keys');
const passiveAllInHistory = {
  ...observation,
  actionHistory: [{
    ...observation.actionHistory[0], type: 'allin', key: 'allin',
    isAggressive: false, raiseIncrement: 0,
  }],
};
const passiveCallHistory = {
  ...observation,
  actionHistory: [{
    ...observation.actionHistory[0], type: 'call', key: 'call',
    isAggressive: false, raiseIncrement: 0,
  }],
};
assert.equal(buildBlueprintInfoSetKey(passiveAllInHistory),
  buildBlueprintInfoSetKey(passiveCallHistory),
  'a short passive all-in and the trainer call action must share public history semantics');

const rawCheckpoint = {
  schema: BLUEPRINT_SCHEMA,
  version: BLUEPRINT_VERSION,
  metadata: {
    algorithm: 'linear-mccfr',
    abstraction: BLUEPRINT_ABSTRACTION,
    seed: 17,
    iterations: 1234,
    tableSize: 6,
  },
  blendWeight: 0.9,
  infosets: {
    [informationSetKey]: {
      strategy: {
        fold: 0,
        check: 0.4, // illegal while facing a bet; it must be filtered, not redirected.
        'raise:feint': 0.6,
      },
      visits: 100,
    },
  },
  trainerState: { massivePrivateTrainingStateIgnoredByRuntime: true },
};
const checkpoint = compileBlueprintCheckpoint(rawCheckpoint);
assert.equal(frozenBlueprintPolicySha256(rawCheckpoint), createHash('sha256')
  .update(canonicalJsonForHash({
    schema: rawCheckpoint.schema,
    version: rawCheckpoint.version,
    metadata: rawCheckpoint.metadata,
    blendWeight: rawCheckpoint.blendWeight,
    infosets: rawCheckpoint.infosets,
  })).digest('hex'), 'browser-safe canonical SHA must match Node crypto');
assert.equal(checkpoint.size, 1);
assert.strictEqual(compileBlueprintCheckpoint(checkpoint), checkpoint,
  'compilation should be idempotent for an already compiled checkpoint');
assert.equal(checkpoint.trainerState, undefined, 'runtime must not retain resumable trainer state');
assert.equal(lookupBlueprintDistribution(checkpoint, informationSetKey).strategy[1].actionKey,
  'raise:feint');
assert.equal(lookupBlueprintDistribution(checkpoint, informationSetKey).visits, 100);
assert.equal(Object.isFrozen(lookupBlueprintDistribution(checkpoint, informationSetKey)), true);
assert.equal(Object.isFrozen(lookupBlueprintDistribution(checkpoint, informationSetKey).strategy), true);

const basePolicy = Object.freeze({
  action: Object.freeze({ type: 'call' }),
  distribution: Object.freeze([
    Object.freeze({ action: Object.freeze({ type: 'fold' }), probability: 0.25, ev: 0 }),
    Object.freeze({ action: Object.freeze({ type: 'call' }), probability: 0.75, ev: 80 }),
  ]),
  selected: Object.freeze({ action: Object.freeze({ type: 'call' }), ev: 80 }),
});

let rngCalls = 0;
assert.strictEqual(blendBlueprintPolicy(basePolicy, {
  observation,
  opts: legalActions,
  rng: () => { rngCalls++; return 0; },
}), basePolicy, 'no checkpoint must preserve the exact old policy object');
assert.equal(rngCalls, 0, 'disabled blueprint path must not perturb deterministic RNG streams');

const missedCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey.replace('h=AKs', 'h=72o')]: {
      strategy: { call: 1 }, visits: 100,
    },
  },
});
assert.strictEqual(blendBlueprintPolicy(basePolicy, {
  checkpoint: missedCheckpoint,
  observation,
  opts: legalActions,
  rng: () => { rngCalls++; return 0; },
}), basePolicy, 'an untrained information set must fall back byte-for-byte to range/EV policy');
assert.equal(rngCalls, 0);

const cappedCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: { ...rawCheckpoint.metadata, maxRaisesPerStreet: 1 },
  infosets: {
    [cappedTrainerKey]: { strategy: { call: 1 }, visits: 100 },
  },
});
const cappedDecision = blendBlueprintPolicy(basePolicy, {
  checkpoint: cappedCheckpoint,
  observation: capReachedObservation,
  opts: legalActions,
  gateRng: () => 0.99,
});
assert.strictEqual(cappedDecision, basePolicy);
assert.equal(getBlueprintPolicyDiagnostics(cappedDecision).backoffLevel, 'exact',
  'runtime must look up the same explicit raise-cap key produced by training');

const backoffOnlyCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [positionBackoffKey]: {
      strategy: { 'raise:feint': 1 }, visits: 200,
    },
  },
});
const backoffPolicy = blendBlueprintPolicy(basePolicy, {
  checkpoint: backoffOnlyCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => 0,
  actionRng: () => 0,
});
assert.equal(backoffPolicy.action.type, 'raise');
assert.equal(getBlueprintPolicyDiagnostics(backoffPolicy).backoffLevel, 'position');
assert.equal(getBlueprintPolicyDiagnostics(backoffPolicy).nodeVisits, 200,
  'runtime must safely use a higher-visit public backoff when the exact node is absent');
assert.equal(getBlueprintPolicyDiagnostics(backoffPolicy).backoffMultiplier, 0.35,
  'coarser backoffs must have a lower intervention cap than exact nodes');

const populationOnlyCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: {
    ...rawCheckpoint.metadata,
    publication: {
      backoffPublished: true,
      reachEvidenceAvailable: true,
      minBackoffVisits: 200,
      minPopulationRoots: 3,
      minReachDecisions: 6,
      minReachGroups: 2,
    },
  },
  infosets: {
    [populationBackoffKey]: {
      strategy: { 'raise:feint': 1 }, visits: 500,
      distinctSourceExactRoots: 3,
      sourceReachDecisions: 6,
      sourceReachProfiles: 1,
      sourceReachGroups: 2,
    },
  },
});
const populationPolicy = blendBlueprintPolicy(basePolicy, {
  checkpoint: populationOnlyCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => 0,
  actionRng: () => 0,
});
assert.equal(getBlueprintPolicyDiagnostics(populationPolicy).backoffLevel, 'population');
assert.equal(getBlueprintPolicyDiagnostics(populationPolicy).backoffMultiplier, 0,
  'population generalization must remain shadow-only before formal promotion');

const sparseExactCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey]: { strategy: { call: 1 }, visits: 1 },
    [historyBackoffKey]: { strategy: { 'raise:feint': 1 }, visits: 80 },
  },
});
const sparseExactPolicy = blendBlueprintPolicy(basePolicy, {
  checkpoint: sparseExactCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => 0,
  actionRng: () => 0,
});
assert.equal(getBlueprintPolicyDiagnostics(sparseExactPolicy).backoffLevel, 'history');
assert.equal(getBlueprintPolicyDiagnostics(sparseExactPolicy).nodeVisits, 80,
  'a sparse exact node must yield to the first sufficiently visited legal backoff');

const mixed = blendBlueprintPolicy(basePolicy, {
  checkpoint,
  observation,
  opts: legalActions,
  maxBlueprintWeight: 0.35,
  minVisits: 0,
  gateRng: () => 0,
  actionRng: () => 0,
});
assert.equal(mixed.blueprint.weight, 0.35, 'checkpoint requested weight must obey runtime cap');
assert.equal(mixed.action.type, 'raise');
assert.equal(mixed.action.tier.key, 'feint');
assert.deepEqual(mixed.distribution.map((candidate) => [
  actionToBlueprintKey(candidate.action),
  Number(candidate.probability.toFixed(4)),
]), [
  ['fold', 0.1625],
  ['call', 0.4875],
  ['raise:feint', 0.35],
]);
assert.ok(mixed.distribution.every((candidate) => actionFromBlueprintKey(
  actionToBlueprintKey(candidate.action), legalActions,
)), 'every sampled candidate must pass the live legal-action boundary');

const guardedCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: {
    ...rawCheckpoint.metadata,
    advantageGuard: {
      enabled: true, minSamples: 20, confidenceZ: 1.96, minLowerBound: 0,
    },
  },
  infosets: {
    [informationSetKey]: {
      strategy: { 'raise:feint': 1 },
      visits: 100,
      actionValues: {
        fold: { samples: 100, mean: -1, m2: 0 },
        call: { samples: 100, mean: 0, m2: 0 },
        'raise:feint': { samples: 100, mean: 2, m2: 0 },
      },
    },
  },
});
const guardedPolicy = blendBlueprintPolicy(basePolicy, {
  checkpoint: guardedCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => 0,
  actionRng: () => 0,
});
assert.equal(guardedPolicy.action.type, 'raise');
assert.equal(getBlueprintPolicyDiagnostics(guardedPolicy).advantagePassed, true);
assert.equal(getBlueprintPolicyDiagnostics(guardedPolicy).advantageLowerBound, 2.25,
  'the guard compares the blueprint and complete base distributions');

let blockedGuardRngCalls = 0;
const losingGuardedCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: guardedCheckpoint.metadata,
  infosets: {
    [informationSetKey]: {
      strategy: { 'raise:feint': 1 },
      visits: 100,
      actionValues: {
        fold: { samples: 100, mean: -1, m2: 0 },
        call: { samples: 100, mean: 0, m2: 0 },
        'raise:feint': { samples: 100, mean: -2, m2: 0 },
      },
    },
  },
});
const guardBlocked = blendBlueprintPolicy(basePolicy, {
  checkpoint: losingGuardedCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => { blockedGuardRngCalls++; return 0; },
  actionRng: () => { blockedGuardRngCalls++; return 0; },
});
assert.strictEqual(guardBlocked, basePolicy);
assert.equal(blockedGuardRngCalls, 0, 'a failed advantage guard must consume no RNG');
assert.equal(getBlueprintPolicyDiagnostics(guardBlocked).eligible, false);
assert.equal(getBlueprintPolicyDiagnostics(guardBlocked).advantagePassed, false);
assert(getBlueprintPolicyDiagnostics(guardBlocked).advantageLowerBound < 0);

const incompleteGuardedCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: guardedCheckpoint.metadata,
  infosets: {
    [informationSetKey]: {
      strategy: { 'raise:feint': 1 }, visits: 100,
      actionValues: {
        'raise:feint': { samples: 100, mean: 2, m2: 0 },
      },
    },
  },
});
blendBlueprintPolicy(basePolicy, {
  checkpoint: incompleteGuardedCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => { blockedGuardRngCalls++; return 0; },
});
assert.equal(getBlueprintPolicyDiagnostics(basePolicy).advantageComplete, false,
  'missing value evidence for a base action must fail closed');
assert.equal(blockedGuardRngCalls, 0);

// Independent exact-root evidence is attached only after the policy is
// frozen. Every record carries a fixed legal-action vector and opaque,
// independent seed-cluster means.
const tournamentValueSource = {
  sha256: 'a'.repeat(64),
  qualityReportSha256: 'b'.repeat(64),
};
const calibratedRawCheckpoint = {
  ...rawCheckpoint,
  metadata: {
    ...rawCheckpoint.metadata,
    tournamentValueSource,
    advantageGuard: {
      enabled: true, minSamples: 4, confidenceZ: 1.96, minLowerBound: 0,
    },
  },
  infosets: {
    [informationSetKey]: {
      strategy: { 'raise:feint': 1 },
      visits: 100,
      // Deliberately pessimistic training moments: calibrated evidence must be
      // distinguishable from, rather than silently merged into, this guard.
      actionValues: {
        fold: { samples: 100, mean: -1, m2: 0 },
        call: { samples: 100, mean: 0, m2: 0 },
        'raise:feint': { samples: 100, mean: -5, m2: 0 },
      },
    },
  },
};
const calibrationActionKeys = [
  'fold', 'call', 'raise:feint', 'raise:strike', 'allin',
];
const calibrationSeeds = ['cal-new-1', 'cal-new-2', 'cal-new-3', 'cal-new-4', 'cal-new-5'];
const basePolicyContract = 'qyj-range-ev-v1';
const baseStyleKey = 'tag';
const calibrationRecord = {
  informationSetKey,
  actionMask: '5d',
  actionKeys: calibrationActionKeys,
  clusters: calibrationSeeds.map((seedCluster, index) => {
    const value = [-1, -0.2, 0.55 + index * 0.05, 0.3, 0.2];
    return { seedCluster, actionVectors: [value, [...value]] };
  }),
};
const exactCalibration = buildFrozenExactRootCalibration(
  calibratedRawCheckpoint,
  [calibrationRecord],
  {
    clusterIdSecret: 'independent-calibration-secret-'.repeat(2),
    forbiddenSeedClusters: ['old-training-cluster', 'old-league-cluster'],
    basePolicyContract,
    baseStyleKey,
    bootstrapIterations: 200,
  },
);
assert.equal(exactCalibration.records[informationSetKey].independentClusterCount, 5);
assert(!JSON.stringify(exactCalibration).includes('cal-new-'),
  'raw calibration seeds must never enter a publishable artifact');
assert(exactCalibration.records[informationSetKey].clusters.every(
  (cluster) => /^fc_[0-9a-f]{64}$/.test(cluster.clusterId),
), 'cluster identities must be opaque HMAC digests');
const calibratedAttached = attachFrozenExactRootCalibration(
  calibratedRawCheckpoint, exactCalibration,
);
const calibratedCheckpoint = compileBlueprintCheckpoint(calibratedAttached);
const calibratedDecision = blendBlueprintPolicy(basePolicy, {
  checkpoint: calibratedCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => 0,
  actionRng: () => 0,
  basePolicyContract,
  baseStyleKey,
});
const calibratedDiagnostics = getBlueprintPolicyDiagnostics(calibratedDecision);
assert.equal(calibratedDecision.action.type, 'raise');
assert.equal(calibratedDiagnostics.advantageEvidence, 'frozen-exact-calibration');
assert.equal(calibratedDiagnostics.advantagePassed, true,
  'paired independent-cluster evidence may supersede losing training moments at the exact node');
assert(calibratedDiagnostics.advantageTLowerBound > 0
  && calibratedDiagnostics.advantageBootstrapLowerBound > 0
  && calibratedDiagnostics.advantageLowerBound
    === Math.min(calibratedDiagnostics.advantageTLowerBound,
      calibratedDiagnostics.advantageBootstrapLowerBound),
'runtime must use the more conservative small-sample t/cluster-bootstrap lower bound');

const changedBaseContract = blendBlueprintPolicy(basePolicy, {
  checkpoint: calibratedCheckpoint,
  observation,
  opts: legalActions,
  basePolicyContract: 'qyj-range-ev-v2',
  baseStyleKey,
  gateRng: () => { blockedGuardRngCalls++; return 0; },
});
assert.strictEqual(changedBaseContract, basePolicy);
assert.equal(getBlueprintPolicyDiagnostics(changedBaseContract).advantageEvidence,
  'training-action-values');
assert.equal(getBlueprintPolicyDiagnostics(changedBaseContract).advantagePassed, false,
  'a changed base-policy contract must disable narrow calibration and retain the old guard');

assert.throws(() => compileBlueprintCheckpoint({
  ...calibratedAttached,
  metadata: { ...calibratedAttached.metadata, algorithm: 'tampered-after-calibration' },
}), /frozen policy SHA-256 does not match/,
'any policy mutation must invalidate independently sampled calibration');
assert.throws(() => buildFrozenExactRootCalibration(
  calibratedRawCheckpoint,
  [calibrationRecord],
  {
    clusterIdSecret: 'independent-calibration-secret-'.repeat(2),
    forbiddenSeedClusters: ['cal-new-3'],
    basePolicyContract,
    baseStyleKey,
    bootstrapIterations: 200,
  },
), /overlaps a forbidden prior seed cluster/,
'calibration collection must reject reuse of a training/tuning seed cluster');

// Even when an exact node has valid independent evidence, selecting a
// published backoff must use only its legacy training actionValues guard.
const calibratedBackoffRaw = {
  ...calibratedRawCheckpoint,
  infosets: {
    [informationSetKey]: { strategy: { 'raise:feint': 1 }, visits: 1 },
    [historyBackoffKey]: {
      strategy: { 'raise:feint': 1 },
      visits: 100,
      actionValues: {
        fold: { samples: 100, mean: -1, m2: 0 },
        call: { samples: 100, mean: 0, m2: 0 },
        'raise:feint': { samples: 100, mean: -2, m2: 0 },
      },
    },
  },
};
const calibratedBackoffArtifact = buildFrozenExactRootCalibration(
  calibratedBackoffRaw,
  [calibrationRecord],
  {
    clusterIdSecret: 'independent-calibration-secret-'.repeat(2),
    forbiddenSeedClusters: ['old-training-cluster'],
    basePolicyContract,
    baseStyleKey,
    bootstrapIterations: 200,
  },
);
const calibratedBackoffCheckpoint = compileBlueprintCheckpoint(
  attachFrozenExactRootCalibration(calibratedBackoffRaw, calibratedBackoffArtifact),
);
const calibrationNarrowingBlocked = blendBlueprintPolicy(basePolicy, {
  checkpoint: calibratedBackoffCheckpoint,
  observation,
  opts: legalActions,
  minVisits: 50,
  gateRng: () => { blockedGuardRngCalls++; return 0; },
});
assert.strictEqual(calibrationNarrowingBlocked, basePolicy);
assert.equal(getBlueprintPolicyDiagnostics(calibrationNarrowingBlocked).backoffLevel, 'history');
assert.equal(getBlueprintPolicyDiagnostics(calibrationNarrowingBlocked).advantageEvidence,
  'training-action-values', 'backoff must never consume narrower exact calibration evidence');
assert.equal(getBlueprintPolicyDiagnostics(calibrationNarrowingBlocked).advantagePassed, false);

let rejectGateCalls = 0;
let rejectActionCalls = 0;
const gateRejected = blendBlueprintPolicy(basePolicy, {
  checkpoint,
  observation,
  opts: legalActions,
  minVisits: 0,
  gateRng: () => { rejectGateCalls++; return 0.99; },
  actionRng: () => { rejectActionCalls++; return 0; },
});
assert.strictEqual(gateRejected, basePolicy);
assert.equal(rejectGateCalls, 1);
assert.equal(rejectActionCalls, 0,
  'rejected intervention must preserve the sampled base action without resampling either policy');
assert.equal(getBlueprintPolicyDiagnostics(gateRejected).intervened, false);
assert.strictEqual(blendBlueprintPolicy(basePolicy, { observation, opts: legalActions }), basePolicy);
assert.equal(getBlueprintPolicyDiagnostics(basePolicy), null,
  'reusing a base-policy object on a disabled decision must clear stale hit diagnostics');

let acceptGateCalls = 0;
let acceptActionCalls = 0;
const gateAccepted = blendBlueprintPolicy(basePolicy, {
  checkpoint,
  observation,
  opts: legalActions,
  minVisits: 0,
  gateRng: () => { acceptGateCalls++; return 0; },
  actionRng: () => { acceptActionCalls++; return 0; },
});
assert.equal(acceptGateCalls, 1);
assert.equal(acceptActionCalls, 1);
assert.equal(getBlueprintPolicyDiagnostics(gateAccepted).intervened, true);
assert.equal(getBlueprintPolicyDiagnostics(gateAccepted).actionChanged, true);

const sameAsBaseCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey]: {
      strategy: { fold: 0.25, call: 0.75 }, visits: 100,
    },
  },
});
let noEffectRngCalls = 0;
const noEffect = blendBlueprintPolicy(basePolicy, {
  checkpoint: sameAsBaseCheckpoint,
  observation,
  opts: legalActions,
  gateRng: () => { noEffectRngCalls++; return 0; },
  actionRng: () => { noEffectRngCalls++; return 0; },
});
assert.strictEqual(noEffect, basePolicy);
assert.equal(noEffectRngCalls, 0, 'TV=0 must not consume either intervention RNG');
assert.equal(getBlueprintPolicyDiagnostics(noEffect).policyTV, 0);
assert.equal(getBlueprintPolicyDiagnostics(noEffect).influence, 0);

const lowVisitCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey]: { strategy: { 'raise:feint': 1 }, visits: 50 },
  },
});
const lowVisitMix = blendBlueprintPolicy(basePolicy, {
  checkpoint: lowVisitCheckpoint,
  observation,
  opts: legalActions,
  maxBlueprintWeight: 0.35,
  gateRng: () => 0.99,
});
const lowVisitDiagnostics = getBlueprintPolicyDiagnostics(lowVisitMix);
assert.strictEqual(lowVisitMix, basePolicy,
  'a rejected causal gate must return the exact sampled base policy object');
assert.equal(lowVisitDiagnostics.confidence, 0.5,
  'per-infoset visit confidence must shrink an under-trained node');
assert.equal(lowVisitDiagnostics.weight, 0.175,
  'visit confidence applies below the hard runtime weight cap');

const illegalOnlyCheckpoint = compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: { [informationSetKey]: { strategy: { check: 1 }, visits: 100 } },
});
assert.strictEqual(blendBlueprintPolicy(basePolicy, {
  checkpoint: illegalOnlyCheckpoint,
  observation,
  opts: legalActions,
  rng: () => { rngCalls++; return 0; },
}), basePolicy, 'an infoset with no currently legal action must not alter the old policy');
assert.equal(rngCalls, 0);

assert.deepEqual(legalizeBlueprintAction(
  { type: 'raise', tier: { key: 'not-live' } }, legalActions,
), { type: 'fold' }, 'the final legality guard must reject stale checkpoint raise tiers');
assert.equal(actionFromBlueprintKey('check', legalActions), null);
assert.deepEqual(actionFromBlueprintKey('allin', {
  ...legalActions,
  callAmount: 100,
  allInAmount: 100,
}), { type: 'call' }, 'a call-for-all-in must not be decoded as an aggressive action');
assert.equal(mixed.blueprint.informationSetKey, undefined,
  'diagnostics must not expose the key because it encodes the observer own hand');

assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  schema: 'foreign-blueprint',
}), /Unsupported blueprint checkpoint/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey]: { strategy: { call: Number.NaN }, visits: 100 },
  },
}), /finite non-negative probability/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey]: {
      strategy: { call: 1 }, visits: 2,
      actionValues: { call: { samples: 3, mean: 0, m2: 0 } },
    },
  },
}), /must not exceed visits/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: {
    ...rawCheckpoint.metadata,
    advantageGuard: { enabled: true, minSamples: 1 },
  },
}), /minSamples/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: {
    [informationSetKey]: { strategy: { 'shell:command': 1 }, visits: 100 },
  },
}), /unsupported action key/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  schema: 'qyj-blueprint-v1',
  version: 1,
}), /Unsupported blueprint checkpoint/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  metadata: { algorithm: 'test' },
}), /Unsupported blueprint abstraction/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: { 'bp1|legacy=true': { strategy: { call: 1 }, visits: 10 } },
}), /does not use the v2 abstraction/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  infosets: { [informationSetKey]: { strategy: { call: 1 } } },
}), /positive safe integer/);
assert.throws(() => compileBlueprintCheckpoint({
  ...rawCheckpoint,
  blendWeight: -0.01,
}), /blendWeight/);

const mutableCheckpoint = structuredClone(rawCheckpoint);
mutableCheckpoint.metadata.gameConfig = { round: 3, nested: { tableSize: 6 } };
const immutableCompiled = compileBlueprintCheckpoint(mutableCheckpoint);
mutableCheckpoint.metadata.gameConfig.round = 12;
mutableCheckpoint.metadata.gameConfig.nested.tableSize = 9;
mutableCheckpoint.infosets[informationSetKey].strategy['raise:feint'] = 0;
assert.equal(immutableCompiled.metadata.gameConfig.round, 3);
assert.equal(immutableCompiled.metadata.gameConfig.nested.tableSize, 6);
assert.equal(Object.isFrozen(immutableCompiled.metadata.gameConfig.nested), true,
  'compiled checkpoint metadata must be recursively copied and frozen');
assert.equal(lookupBlueprintDistribution(immutableCompiled, informationSetKey)
  .strategy.find((item) => item.actionKey === 'raise:feint').probability, 0.6,
'mutating raw strategy data after compilation must not alter the runtime table');

let fetchCalls = 0;
const fetched = await loadBlueprintCheckpoint('/assets/ai/blueprint.json', {
  fetchImpl: async (url, init) => {
    fetchCalls++;
    assert.equal(url, '/assets/ai/blueprint.json');
    assert.equal(init.credentials, 'same-origin');
    return { ok: true, json: async () => rawCheckpoint };
  },
});
assert.equal(fetchCalls, 1);
assert.equal(fetched.size, 1);
assert.equal(await loadBlueprintCheckpoint(null), null);

console.log('Blueprint policy tests passed: shared infosets, static load, bounded mix, legal fallback.');
