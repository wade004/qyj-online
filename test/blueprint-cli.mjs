import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { ExternalSamplingMccfr } from '../training/blueprint/mccfr.js';
import {
  abstractObservation,
  QyjAbstractHoldemGame,
} from '../training/blueprint/qyj-abstract-game.js';
import { SerializableRng } from '../training/blueprint/rng.js';
import {
  ExactInfosetReachProfiler,
  buildExactInfosetTrainingSnapshot,
} from '../training/blueprint/target-profile.js';
import { buildTargetKeyFromSnapshot } from '../training/blueprint/targeted.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resultDir = resolve(root, 'test-results');
mkdirSync(resultDir, { recursive: true });
const prefix = `blueprint-cli-${process.pid}`;
const firstPath = resolve(resultDir, `${prefix}-first.json`);
const revisedPath = resolve(resultDir, `${prefix}-revised.json`);
const exactPath = resolve(resultDir, `${prefix}-exact.json`);
const backoffPath = resolve(resultDir, `${prefix}-backoff.json`);
const targetedSixProfilePath = resolve(resultDir, `${prefix}-target-profile-6.json`);
const targetedSixDuplicatePath = resolve(resultDir, `${prefix}-target-profile-6b.json`);
const targetedNineProfilePath = resolve(resultDir, `${prefix}-target-profile-9.json`);
const targetedConflictProfilePath = resolve(resultDir, `${prefix}-target-profile-conflict.json`);
const targetedMultiPath = resolve(resultDir, `${prefix}-targeted-multi.json`);
const targetedMultiReversePath = resolve(resultDir, `${prefix}-targeted-multi-reverse.json`);
const targetedSinglePath = resolve(resultDir, `${prefix}-targeted-single.json`);
const targetedConflictOutputPath = resolve(resultDir, `${prefix}-targeted-conflict.json`);
const targetedDuplicateOutputPath = resolve(resultDir, `${prefix}-targeted-duplicate.json`);
const leagueProfileV2Path = resolve(resultDir, `${prefix}-league-profile-v2.json`);

function runScript(script, args, env = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function run(args) {
  return runScript('training/train-blueprint.mjs', args);
}

function targetedProfile({ nominalTableSize, round, seed }) {
  const game = new QyjAbstractHoldemGame({
    tableSize: 2,
    round,
    maxRaisesPerStreet: 0,
  });
  const state = game.createInitialState(new SerializableRng(seed));
  const observation = abstractObservation(state, state.actingSeat);
  const sanitized = buildExactInfosetTrainingSnapshot(observation);
  // A real six/nine-seat tournament can have only two live hand seats. Keep
  // this CLI fixture cheap while retaining the nominal public table capacity.
  sanitized.publicSeatCapacity = nominalTableSize;
  sanitized.tournament = null;
  const { observerIdx: actorIdx, ...snapshot } = sanitized;
  const exactKey = buildTargetKeyFromSnapshot(snapshot, actorIdx, {
    maxRaisesPerStreet: 0,
  });
  const profiler = new ExactInfosetReachProfiler({ top: 8, variantsPerKey: 4 });
  profiler.observe({
    exactKey,
    strategy: 'qyz',
    street: snapshot.street,
    trainingSnapshot: sanitized,
    actionKey: snapshot.legalActions.canCheck ? 'check' : 'call',
  });
  return profiler.finalize({
    tableSize: nominalTableSize,
    skillsEnabled: false,
    maxRaisesPerStreet: 0,
    strategies: ['qyz'],
    matches: 1,
    fullScheduleMatches: 1,
  });
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

const first = run([
  '--iterations', '2',
  '--seed', 'cli-contract-a',
  '--blend-weight', '0.2',
  '--progress', '2',
  '--output', firstPath,
]);
assert.equal(first.status, 0, first.stderr);
const saved = JSON.parse(readFileSync(firstPath, 'utf8'));
assert.equal(saved.metadata.seed, 'cli-contract-a');
assert.equal(saved.blendWeight, 0.2);

const changedSeed = run([
  '--resume', firstPath,
  '--iterations', '0',
  '--seed', 'cli-contract-b',
  '--output', revisedPath,
]);
assert.notEqual(changedSeed.status, 0, 'resume must reject a different explicit seed');
assert.match(changedSeed.stderr, /seed cannot change when resuming/i);

const revisedBlend = run([
  '--resume', firstPath,
  '--iterations', '0',
  '--seed', 'cli-contract-a',
  '--blend-weight', '0.31',
  '--output', revisedPath,
]);
assert.equal(revisedBlend.status, 0, revisedBlend.stderr);
const revised = JSON.parse(readFileSync(revisedPath, 'utf8'));
assert.equal(revised.metadata.seed, 'cli-contract-a');
assert.equal(revised.metadata.iterations, saved.metadata.iterations);
assert.equal(revised.blendWeight, 0.31,
  'explicit blend weight on resume must update the exported runtime setting');
assert.deepEqual(revised.trainerState.rng, saved.trainerState.rng,
  'changing only blend weight must not consume or replace training RNG state');

const invalidBlend = run(['--iterations', '0', '--blend-weight', '1.1', '--output', revisedPath]);
assert.notEqual(invalidBlend.status, 0);
assert.match(invalidBlend.stderr, /blendWeight must be in 0\.\.1/);

const publicationTrainer = new ExternalSamplingMccfr(new QyjAbstractHoldemGame({
  tableSize: 2,
  round: 2,
  maxRaisesPerStreet: 0,
}), { seed: 'cli-publication-source' });
publicationTrainer.train(5);
writeFileSync(exactPath, `${JSON.stringify(publicationTrainer.toCheckpoint({
  includeTrainerState: false,
}))}\n`, 'utf8');

const publishBackoff = runScript('training/publish-blueprint-backoff.mjs', [
  '--input', exactPath,
  '--output', backoffPath,
  '--min-exact-visits', '1',
  '--min-backoff-visits', '1',
]);
assert.equal(publishBackoff.status, 0, publishBackoff.stderr);
const published = JSON.parse(readFileSync(backoffPath, 'utf8'));
assert.equal(published.metadata.publication.backoffPublished, true);
assert.equal(published.metadata.publication.exactOnly, false);
assert.equal(
  published.metadata.publication.derivation,
  'welford-merged-distinct-exact-roots-diagnostic-no-reach-evidence',
);
assert.equal(published.metadata.publication.minBackoffRoots, 2);
assert.equal(published.metadata.publication.minPopulationRoots, 3);
assert.equal(published.metadata.publication.reachEvidenceAvailable, false);
assert(Object.keys(published.infosets).some((key) => key.includes('|bk=')),
  'publication CLI must derive hierarchical nodes from exact roots');

const overwriteSource = runScript('training/publish-blueprint-backoff.mjs', [
  '--input', exactPath,
  '--output', exactPath,
]);
assert.notEqual(overwriteSource.status, 0,
  'publication CLI must not overwrite its exact source artifact');
assert.match(overwriteSource.stderr, /output must differ from --input/i);

const missingExactSource = runScript('training/publish-blueprint-backoff.mjs', [
  '--input', firstPath,
  '--output', backoffPath,
]);
assert.notEqual(missingExactSource.status, 0,
  'publication CLI must reject an artifact whose exact roots were already removed');
assert.match(missingExactSource.stderr, /at least one exact infoset root/i);

// The targeted CLI accepts independently collected table-size profiles while
// preserving one global target set and one trainTargetedBlueprint invocation.
const sixProfile = targetedProfile({
  nominalTableSize: 6,
  round: 2,
  seed: 'targeted-cli-six',
});
const sixDuplicateProfile = structuredClone(sixProfile);
sixDuplicateProfile.collection.matches = 2;
const nineProfile = targetedProfile({
  nominalTableSize: 9,
  round: 8,
  seed: 'targeted-cli-nine',
});
const sixProfileText = `${JSON.stringify(sixProfile, null, 2)}\n`;
const sixDuplicateText = `${JSON.stringify(sixDuplicateProfile, null, 2)}\n`;
const nineProfileText = `${JSON.stringify(nineProfile, null, 2)}\n`;
writeFileSync(targetedSixProfilePath, sixProfileText, 'utf8');
writeFileSync(targetedSixDuplicatePath, sixDuplicateText, 'utf8');
writeFileSync(targetedNineProfilePath, nineProfileText, 'utf8');

const targetedArgs = [
  '--visits', '50',
  '--top', '1',
  '--max-raises', '0',
  '--seed', 'targeted-cli-multi-profile',
  '--quiet',
];
const targetedMulti = runScript('training/train-blueprint-targeted.mjs', [
  '--profile', targetedSixProfilePath,
  '--profile', targetedSixDuplicatePath,
  '--profile', targetedNineProfilePath,
  ...targetedArgs,
  '--output', targetedMultiPath,
]);
assert.equal(targetedMulti.status, 0, targetedMulti.stderr);
const targetedMultiReverse = runScript('training/train-blueprint-targeted.mjs', [
  '--profile', targetedNineProfilePath,
  '--profile', targetedSixDuplicatePath,
  '--profile', targetedSixProfilePath,
  ...targetedArgs,
  '--output', targetedMultiReversePath,
]);
assert.equal(targetedMultiReverse.status, 0, targetedMultiReverse.stderr);
assert.equal(
  readFileSync(targetedMultiReversePath, 'utf8'),
  readFileSync(targetedMultiPath, 'utf8'),
  'profile argument order must not change a deterministic merged checkpoint byte',
);

const mergedTargeted = JSON.parse(readFileSync(targetedMultiPath, 'utf8'));
assert.equal(mergedTargeted.metadata.targetCount, 2);
assert.equal(mergedTargeted.metadata.targetVariantCount, 2);
assert.equal(Object.keys(mergedTargeted.infosets).length, 2);
assert.equal(mergedTargeted.metadata.sourceProfile, undefined,
  'a multi-profile artifact must not mislabel one source as the singular source');
assert.deepEqual(mergedTargeted.metadata.sourceProfileMerge, {
  profileCount: 3,
  tableSizes: [6, 9],
  selectedExactKeyOccurrences: 3,
  selectedTargetVariantOccurrences: 3,
  mergedExactKeys: 2,
  mergedTargetVariants: 2,
  duplicateTargetVariantsRemoved: 1,
});
assert.deepEqual(
  mergedTargeted.metadata.sourceProfiles.map((source) => source.tableSize),
  [6, 6, 9],
);
assert.deepEqual(
  mergedTargeted.metadata.sourceProfiles.map((source) => source.sha256).sort(),
  [sha256(sixProfileText), sha256(sixDuplicateText), sha256(nineProfileText)].sort(),
);
assert.equal(
  mergedTargeted.metadata.sourceProfiles
    .filter((source) => source.tableSize === 6)
    .every((source) => source.sharedTargetVariants === 1),
  true,
  'the duplicate cross-profile target variant must be attributed then trained once',
);

const targetedSingle = runScript('training/train-blueprint-targeted.mjs', [
  '--profile', targetedSixProfilePath,
  '--visits', '50',
  '--top', '1',
  '--max-raises', '0',
  '--seed', 'targeted-cli-single-profile',
  '--quiet',
  '--output', targetedSinglePath,
]);
assert.equal(targetedSingle.status, 0, targetedSingle.stderr);
const singleTargeted = JSON.parse(readFileSync(targetedSinglePath, 'utf8'));
assert.deepEqual(singleTargeted.metadata.sourceProfile, {
  schema: sixProfile.schema,
  version: sixProfile.version,
  sha256: sha256(sixProfileText),
  observedDecisions: 1,
  uniqueExactKeys: 1,
  selectedExactKeys: 1,
  selectedTargetVariants: 1,
  minObservedCount: 1,
});
assert.equal(singleTargeted.metadata.sourceProfiles.length, 1);

const conflictingProfile = structuredClone(nineProfile);
conflictingProfile.entries[0].exactKey = sixProfile.entries[0].exactKey;
writeFileSync(
  targetedConflictProfilePath,
  `${JSON.stringify(conflictingProfile, null, 2)}\n`,
  'utf8',
);
const targetedConflict = runScript('training/train-blueprint-targeted.mjs', [
  '--profile', targetedSixProfilePath,
  '--profile', targetedConflictProfilePath,
  ...targetedArgs,
  '--output', targetedConflictOutputPath,
]);
assert.notEqual(targetedConflict.status, 0);
assert.match(targetedConflict.stderr, /targetKey does not match|cross-profile conflict/i);
assert.equal(existsSync(targetedConflictOutputPath), false,
  'a conflicting profile set must fail before writing a checkpoint');

const targetedDuplicateSource = runScript('training/train-blueprint-targeted.mjs', [
  '--profile', targetedSixProfilePath,
  '--profile', targetedSixProfilePath,
  ...targetedArgs,
  '--output', targetedDuplicateOutputPath,
]);
assert.notEqual(targetedDuplicateSource.status, 0);
assert.match(targetedDuplicateSource.stderr, /duplicate --profile content/i);
assert.equal(existsSync(targetedDuplicateOutputPath), false);

const targetedHelp = runScript('training/train-blueprint-targeted.mjs', ['--help']);
assert.equal(targetedHelp.status, 0, targetedHelp.stderr);
assert.match(targetedHelp.stdout, /--profile PATH.*repeat to merge table sizes/i);

const profileSecret = 'cli-profile-source-group-secret-2026-test';
const profiledLeague = runScript('scripts/run-ai-league.mjs', [
  '--quick',
  '--no-gate',
  '--table', '6',
  '--lineup', 'calling-station',
  '--seed', 'raw-cli-profile-seed-must-not-persist',
  '--exact-infoset-profile', leagueProfileV2Path,
  '--profile-strategies', 'calling-station',
  '--profile-group-secret', 'QYJ_TEST_PROFILE_GROUP_SECRET',
], { QYJ_TEST_PROFILE_GROUP_SECRET: profileSecret });
assert.equal(profiledLeague.status, 0, profiledLeague.stderr);
const leagueProfileV2Text = readFileSync(leagueProfileV2Path, 'utf8');
const leagueProfileV2 = JSON.parse(leagueProfileV2Text);
assert.equal(leagueProfileV2.version, 2);
assert.equal(leagueProfileV2.collection.promotionEligible, true);
assert.equal(leagueProfileV2.collection.sourceGroupCount, 1);
assert.match(leagueProfileV2.collection.sourceGroupSecretId, /^ps_[0-9a-f]{64}$/);
assert.ok(leagueProfileV2.collection.sourceGroups.every((id) => /^pg_[0-9a-f]{64}$/.test(id)));
assert.equal(leagueProfileV2Text.includes('raw-cli-profile-seed-must-not-persist'), false);
assert.equal(leagueProfileV2Text.includes(profileSecret), false);
const missingProfileSecret = runScript('scripts/run-ai-league.mjs', [
  '--quick',
  '--no-gate',
  '--exact-infoset-profile', `${leagueProfileV2Path}.missing.json`,
  '--profile-group-secret', 'QYJ_MISSING_PROFILE_GROUP_SECRET',
]);
assert.notEqual(missingProfileSecret.status, 0);
assert.match(missingProfileSecret.stderr, /environment variable is missing or empty/i);

console.log('blueprint CLI tests passed: resume locks, safe publication and deterministic multi-profile targeted training.');
