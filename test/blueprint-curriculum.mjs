import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  blueprintBackoffKeys,
  compileBlueprintCheckpoint,
  lookupBlueprintDistribution,
} from '../js/game/blueprint-policy.js';
import {
  addBlueprintBackoffInfosets,
  curriculumConfigurations,
  summarizeBlueprintCoverage,
  trainBlueprintCurriculum,
} from '../training/blueprint/curriculum.js';

const configs = curriculumConfigurations({
  tableSizes: [2, 3], rounds: [2, 8], stackBbs: [8], maxRaisesPerStreet: 1,
});
assert.equal(configs.length, 4);
assert.deepEqual(configs.map((config) => [config.tableSize, config.round]), [
  [2, 2], [2, 8], [3, 2], [3, 8],
]);

const options = {
  tableSizes: [2, 3],
  rounds: [2, 8],
  stackBbs: [8],
  iterationsPerConfig: 2,
  minExactVisits: 1,
  minBackoffVisits: 1,
  seed: 'tiny-v2-curriculum',
};
const first = trainBlueprintCurriculum(options);
const second = trainBlueprintCurriculum(options);
assert.deepEqual(second, first, 'curriculum shards and visit-weighted merge must be deterministic');
assert.equal(first.trainerState, undefined, 'a curriculum bundle is runtime-only');
assert.equal(first.metadata.configurations.length, 4);
const keys = Object.keys(first.infosets);
assert(keys.length > 0 && keys.every((key) => key.startsWith('bp2|')));
assert(keys.some((key) => key.includes('|n=2|')) && keys.some((key) => key.includes('|n=3|')),
  'curriculum must publish all requested surviving-player counts');
assert(keys.some((key) => key.includes('|r=l1|')) && keys.some((key) => key.includes('|r=l3|')),
  'curriculum must publish every requested QYJ round level');
const coverage = summarizeBlueprintCoverage(first);
assert.equal(coverage.infoSets, keys.length);
assert(coverage.p50Visits >= 1 && coverage.maxVisits >= coverage.p50Visits);
assert.deepEqual(Object.keys(coverage.levels), [
  'exact', 'history', 'position', 'strategic', 'population',
]);
assert.equal(
  coverage.totalSupportVisits,
  Object.values(coverage.levels).reduce((sum, level) => sum + level.supportVisits, 0),
  'published support must be reported separately for every hierarchy level',
);
assert.equal(
  coverage.infoSets,
  Object.values(coverage.levels).reduce((sum, level) => sum + level.nodeCount, 0),
  'per-level node counts must cover the complete published checkpoint',
);
assert.equal(coverage.totalVisits, coverage.totalSupportVisits,
  'legacy totalVisits must remain an explicitly documented support alias');
assert.equal(coverage.meanVisits, coverage.meanSupportVisits,
  'legacy meanVisits must remain an explicitly documented support alias');
assert.match(coverage.supportVisitsDefinition, /not independent training samples/);
assert.equal(
  coverage.sourceExactVisits,
  first.metadata.publication.sourceExactVisits,
  'curriculum metadata must preserve exact source support before backoff expansion',
);
assert(coverage.sourceExactVisits > 0);
assert.match(coverage.sourceExactVisitsDefinition, /before publication thresholds/);
assert.equal(coverage.sourceExactRootCount, first.metadata.publication.sourceExactRootCount);
assert(coverage.levels.population.nodeCount === 0
  || coverage.levels.population.minDistinctSourceExactRoots >= 3,
'population publication must never substitute rollout visits for three distinct roots');
const compiledFirst = compileBlueprintCheckpoint(first);
assert.equal(compiledFirst.size, keys.length);
const valueKey = keys.find((key) => Object.keys(first.infosets[key].actionValues || {}).length > 0);
assert(valueKey, 'curriculum publication must retain MCCFR action-value moments');
const compiledValueNode = lookupBlueprintDistribution(compiledFirst, valueKey);
assert(compiledValueNode.actionValues?.some((entry) => entry.samples > 0));
assert.equal(first.metadata.advantageGuard.enabled, true,
  'new curriculum checkpoints must fail closed behind the empirical advantage guard');

const exactValueKey = keys.find((key) => (
  !key.includes('|bk=') && Object.keys(first.infosets[key].actionValues || {}).length > 0
));
assert(exactValueKey);
const secondValueKey = exactValueKey.replace(/\|x=[^|]+$/, '|x=SECOND');
const momentFixture = {
  metadata: {},
  infosets: {
    [exactValueKey]: {
      strategy: { call: 1 }, visits: 2,
      actionValues: { call: { samples: 2, mean: 1, m2: 2 } },
    },
    [secondValueKey]: {
      strategy: { call: 1 }, visits: 3,
      actionValues: { call: { samples: 3, mean: 3, m2: 6 } },
    },
  },
};
addBlueprintBackoffInfosets(momentFixture, { minExactVisits: 1, minBackoffVisits: 1 });
const sharedHistoryKey = blueprintBackoffKeys(exactValueKey)[0];
assert.deepEqual(momentFixture.infosets[sharedHistoryKey].actionValues.call, {
  samples: 5, mean: 2.2, m2: 12.8,
}, 'hierarchical publication must combine Welford moments without averaging variances');

// The single-checkpoint publication helper must persist pre-expansion exact
// support even when publication thresholds later remove the exact node.
const exactKey = keys.find((key) => !key.includes('|bk='));
assert(exactKey, 'the min-visit=1 fixture must publish at least one exact node');
const exactEntry = structuredClone(first.infosets[exactKey]);
const exactSource = {
  metadata: {},
  infosets: { [exactKey]: exactEntry },
};
addBlueprintBackoffInfosets(exactSource, {
  minExactVisits: exactEntry.visits + 1,
  minBackoffVisits: 1,
});
assert.equal(exactSource.metadata.publication.sourceExactVisits, exactEntry.visits);
const exactSourceCoverage = summarizeBlueprintCoverage(exactSource);
assert.equal(exactSourceCoverage.levels.exact.nodeCount, 0,
  'the fixture intentionally removes its exact node at publication');
assert.equal(exactSourceCoverage.sourceExactVisits, exactEntry.visits,
  'source exact support must survive even when no exact node is published');
assert.equal(exactSourceCoverage.totalSupportVisits, 0,
  'one heavily visited exact root must not manufacture a general backoff node');

// Older artifacts do not carry the pre-publication counter. Their fallback is
// deliberately narrow: only published exact support, never exact+backoff.
const legacyCoverage = summarizeBlueprintCoverage({
  infosets: {
    'bp2|s=preflop|n=2|r=l1': { visits: 3 },
    'bp2|bk=history|s=preflop|n=2|r=l1': { visits: 7 },
  },
});
assert.equal(legacyCoverage.sourceExactVisits, 3);
assert.equal(legacyCoverage.levels.exact.supportVisits, 3);
assert.equal(legacyCoverage.levels.history.supportVisits, 7);
assert.equal(legacyCoverage.totalSupportVisits, 10);
assert.match(legacyCoverage.sourceExactVisitsDefinition, /published exact-node support/);

const temp = await mkdtemp(join(tmpdir(), 'qyj-blueprint-v2-'));
try {
  const output = join(temp, 'curriculum.json');
  const result = spawnSync(process.execPath, [
    'training/train-blueprint-curriculum.mjs',
    '--iterations', '1',
    '--table-sizes', '2',
    '--rounds', '5',
    '--stack-bbs', '8',
    '--seed', 'curriculum-cli',
    '--min-exact-visits', '1',
    '--min-backoff-visits', '1',
    '--quiet',
    '--output', output,
  ], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(parsed.metadata.configurations.length, 1);
  assert(Object.keys(parsed.infosets).every((key) => (
    key.includes('|n=2|') && key.includes('|r=l2|')
  )));
  assert(compileBlueprintCheckpoint(parsed).size > 0);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('blueprint curriculum tests passed: deterministic 2-9 capable coverage shards and CLI');
