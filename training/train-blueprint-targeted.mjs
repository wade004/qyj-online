#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { compileBlueprintCheckpoint } from '../js/game/blueprint-policy.js';
import { compileTournamentValueModel } from './tournament-value/model.js';
import {
  validateExactInfosetProfile,
} from './blueprint/target-profile.js';
import {
  filterTournamentSafeTargets,
  normalizeTargetDefinition,
  trainTargetedBlueprint,
} from './blueprint/targeted.js';

const DEFAULT_OUTPUT = 'training/checkpoints/qyj-blueprint-v2-targeted.json';

function usage() {
  return `QYJ profile-conditioned exact blueprint trainer

Usage:
  node training/train-blueprint-targeted.mjs --profile PATH [--profile PATH ...] [options]

Options:
  --profile PATH         Exact reach profile; repeat to merge table sizes (required)
  --visits N             Genuine root traverser visits per target (default: 50; min: 50)
  --top N                Train at most N highest-frequency exact keys per profile (default: 64)
  --min-count N          Ignore keys observed fewer than N times (default: 1)
  --seed TEXT            Deterministic targeted-training seed
  --max-raises N         Must match the profile action abstraction, 0..3
  --blend-weight N       Runtime intervention request, 0..1 (default: 0.25)
  --max-depth N          MCCFR recursion guard (default: 160)
  --belief-temperature N Temper public-action likelihoods, 0..1 (default: 0.5)
  --tournament-value-model PATH   Promoted public tournament-value model
  --tournament-value-report PATH  Matching passed held-out quality report
  --tournament-max-uncertainty N  Must not exceed the report calibration gate
  --tournament-max-ood-score N    OOD acceptance score, 0..1 (default: 1)
  --tournament-fallback-share-scale N  Same-scale chip fallback slope (default: 2)
  --filter-unsafe-tournament-roots  Exclude roots that fail the promoted model preflight
  --preflight-only        Validate/filter selected roots without running MCCFR
  --tournament-preflight-report PATH  Write the root-filter diagnostics JSON
  --output PATH          Output checkpoint (default: ${DEFAULT_OUTPUT})
  --quiet                Suppress selection summary
  --help                 Show this message

Only explicit target root infosets are published. Downstream nodes remain training-only.`;
}

function number(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${flag} requires a finite number`);
  return parsed;
}

function parseArgs(argv) {
  const args = {
    profiles: [],
    visits: 50,
    top: 64,
    minCount: 1,
    seed: 'qyj-targeted-blueprint-v1',
    maxRaises: null,
    blendWeight: 0.25,
    maxDepth: 160,
    beliefTemperature: 0.5,
    tournamentValueModel: null,
    tournamentValueReport: null,
    tournamentMaxUncertainty: null,
    tournamentMaxOodScore: 1,
    tournamentFallbackShareScale: 2,
    filterUnsafeTournamentRoots: false,
    preflightOnly: false,
    tournamentPreflightReport: null,
    output: DEFAULT_OUTPUT,
    quiet: false,
  };
  const valueAfter = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--quiet') args.quiet = true;
    else if (flag === '--filter-unsafe-tournament-roots') {
      args.filterUnsafeTournamentRoots = true;
    }
    else if (flag === '--preflight-only') args.preflightOnly = true;
    else if (flag === '--tournament-preflight-report') {
      args.tournamentPreflightReport = valueAfter(index++, flag);
    }
    else if (flag === '--profile') args.profiles.push(valueAfter(index++, flag));
    else if (flag === '--visits') args.visits = number(valueAfter(index++, flag), flag);
    else if (flag === '--top') args.top = number(valueAfter(index++, flag), flag);
    else if (flag === '--min-count') args.minCount = number(valueAfter(index++, flag), flag);
    else if (flag === '--seed') args.seed = valueAfter(index++, flag);
    else if (flag === '--max-raises') args.maxRaises = number(valueAfter(index++, flag), flag);
    else if (flag === '--blend-weight') args.blendWeight = number(valueAfter(index++, flag), flag);
    else if (flag === '--max-depth') args.maxDepth = number(valueAfter(index++, flag), flag);
    else if (flag === '--belief-temperature') {
      args.beliefTemperature = number(valueAfter(index++, flag), flag);
    }
    else if (flag === '--tournament-value-model') {
      args.tournamentValueModel = valueAfter(index++, flag);
    }
    else if (flag === '--tournament-value-report') {
      args.tournamentValueReport = valueAfter(index++, flag);
    }
    else if (flag === '--tournament-max-uncertainty') {
      args.tournamentMaxUncertainty = number(valueAfter(index++, flag), flag);
    }
    else if (flag === '--tournament-max-ood-score') {
      args.tournamentMaxOodScore = number(valueAfter(index++, flag), flag);
    }
    else if (flag === '--tournament-fallback-share-scale') {
      args.tournamentFallbackShareScale = number(valueAfter(index++, flag), flag);
    }
    else if (flag === '--output') args.output = valueAfter(index++, flag);
    else throw new TypeError(`Unknown option ${flag}`);
  }
  if (!args.profiles.length) throw new TypeError('--profile is required');
  for (const [key, min] of [['visits', 50], ['top', 1], ['minCount', 1], ['maxDepth', 1]]) {
    if (!Number.isSafeInteger(args[key]) || args[key] < min) {
      throw new RangeError(`${key} must be a safe integer >= ${min}`);
    }
  }
  if (args.maxRaises != null
    && (!Number.isInteger(args.maxRaises) || args.maxRaises < 0 || args.maxRaises > 3)) {
    throw new RangeError('maxRaises must be an integer in 0..3');
  }
  if (args.blendWeight < 0 || args.blendWeight > 1) {
    throw new RangeError('blendWeight must be in 0..1');
  }
  if (args.beliefTemperature < 0 || args.beliefTemperature > 1) {
    throw new RangeError('beliefTemperature must be in 0..1');
  }
  if (!!args.tournamentValueModel !== !!args.tournamentValueReport) {
    throw new TypeError('tournament value model and report must be provided together');
  }
  if (args.preflightOnly && !args.filterUnsafeTournamentRoots) {
    throw new TypeError('--preflight-only requires --filter-unsafe-tournament-roots');
  }
  if (args.tournamentMaxUncertainty != null && args.tournamentMaxUncertainty < 0) {
    throw new RangeError('tournamentMaxUncertainty must be non-negative');
  }
  if (args.tournamentMaxOodScore < 0 || args.tournamentMaxOodScore > 1) {
    throw new RangeError('tournamentMaxOodScore must be in 0..1');
  }
  if (args.tournamentFallbackShareScale < 0) {
    throw new RangeError('tournamentFallbackShareScale must be non-negative');
  }
  return args;
}

function profileTargets(profile, { top, minCount }) {
  return profile.entries
    .filter((entry) => Number(entry.count) >= minCount)
    .sort((left, right) => Number(right.count) - Number(left.count)
      || String(left.exactKey).localeCompare(String(right.exactKey)))
    .slice(0, top)
    .flatMap((entry) => {
      const variants = Array.isArray(entry.trainingSnapshots)
        ? entry.trainingSnapshots : [entry.trainingSnapshot];
      return variants.map((trainingSnapshot) => {
        const { observerIdx, ...snapshot } = trainingSnapshot;
        return {
          targetKey: entry.exactKey,
          actorIdx: observerIdx,
          snapshot,
        };
      });
    });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function loadProfileSource(profileArg) {
  const sourcePath = resolve(profileArg);
  const text = await readFile(sourcePath, 'utf8');
  const profile = validateExactInfosetProfile(JSON.parse(text));
  if (profile.collection?.skillsEnabled === true) {
    throw new RangeError('targeted no-skill training rejects skill-enabled profiles');
  }
  const tableSize = Number(profile.collection?.tableSize);
  if (!Number.isSafeInteger(tableSize) || tableSize < 2 || tableSize > 9) {
    throw new RangeError('profile tableSize must be an integer in 2..9');
  }
  const maxRaisesPerStreet = Number(profile.collection?.maxRaisesPerStreet);
  if (!Number.isInteger(maxRaisesPerStreet)
    || maxRaisesPerStreet < 0 || maxRaisesPerStreet > 3) {
    throw new RangeError('profile maxRaisesPerStreet must be an integer in 0..3');
  }
  const exactKeys = profile.entries.map((entry) => entry.exactKey);
  if (new Set(exactKeys).size !== exactKeys.length) {
    throw new RangeError('profile contains duplicate exact key entries');
  }
  return {
    sourcePath,
    text,
    profile,
    tableSize,
    maxRaisesPerStreet,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

async function loadProfileSources(profileArgs) {
  const sources = await Promise.all(profileArgs.map(loadProfileSource));
  const hashes = new Set();
  for (const source of sources) {
    if (hashes.has(source.sha256)) {
      throw new RangeError('duplicate --profile content is not allowed');
    }
    hashes.add(source.sha256);
  }
  return sources.sort((left, right) => left.tableSize - right.tableSize
    || left.sha256.localeCompare(right.sha256));
}

function mergeProfileTargets(sources, selection, maxRaisesPerStreet) {
  const variantRecords = new Map();
  const publicStateKeys = new Map();
  let selectedTargetVariantOccurrences = 0;
  let selectedExactKeyOccurrences = 0;

  for (const source of sources) {
    const selected = profileTargets(source.profile, selection);
    if (!selected.length) {
      throw new RangeError(
        `profile table ${source.tableSize} contains no target meeting the selection rules`,
      );
    }
    const localVariantIds = new Set();
    const localExactKeys = new Set();
    for (let index = 0; index < selected.length; index++) {
      const rawTarget = selected[index];
      const snapshotTableSize = Number(
        rawTarget.snapshot.tournament?.tableSize
          ?? rawTarget.snapshot.publicSeatCapacity,
      );
      if (snapshotTableSize !== source.tableSize) {
        throw new RangeError(
          `profile table ${source.tableSize} target snapshot has inconsistent table capacity`,
        );
      }
      let target;
      try {
        target = normalizeTargetDefinition(rawTarget, { maxRaisesPerStreet });
      } catch (cause) {
        throw new Error(
          `profile table ${source.tableSize} target[${index}] failed public-state validation: ${cause.message}`,
          { cause },
        );
      }
      const publicStateId = canonicalJson({
        actorIdx: target.actorIdx,
        snapshot: target.snapshot,
      });
      const previousKey = publicStateKeys.get(publicStateId);
      if (previousKey != null && previousKey !== target.targetKey) {
        throw new RangeError(
          'cross-profile conflict: one public target variant declares different exact keys',
        );
      }
      publicStateKeys.set(publicStateId, target.targetKey);
      const variantId = canonicalJson(target);
      let record = variantRecords.get(variantId);
      if (!record) {
        record = { target, sourceHashes: new Set() };
        variantRecords.set(variantId, record);
      }
      record.sourceHashes.add(source.sha256);
      localVariantIds.add(variantId);
      localExactKeys.add(target.targetKey);
    }
    selectedTargetVariantOccurrences += selected.length;
    selectedExactKeyOccurrences += localExactKeys.size;
    source.selection = {
      selectedExactKeys: localExactKeys.size,
      selectedTargetVariants: selected.length,
      uniqueTargetVariants: localVariantIds.size,
      duplicateTargetVariantsRemoved: selected.length - localVariantIds.size,
      localVariantIds,
    };
  }

  const orderedVariants = [...variantRecords.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  const targets = orderedVariants.map(([, record]) => record.target);
  const mergedExactKeys = new Set(targets.map((target) => target.targetKey)).size;
  const sourceProfiles = sources.map((source) => {
    const sharedTargetVariants = [...source.selection.localVariantIds]
      .filter((variantId) => variantRecords.get(variantId).sourceHashes.size > 1)
      .length;
    return {
      schema: source.profile.schema,
      version: source.profile.version,
      sha256: source.sha256,
      tableSize: source.tableSize,
      observedDecisions: Number(source.profile.collection?.observedDecisions) || 0,
      uniqueExactKeys: Number(source.profile.collection?.uniqueExactKeys) || 0,
      selectedExactKeys: source.selection.selectedExactKeys,
      selectedTargetVariants: source.selection.selectedTargetVariants,
      uniqueTargetVariants: source.selection.uniqueTargetVariants,
      sharedTargetVariants,
      duplicateTargetVariantsRemoved: source.selection.duplicateTargetVariantsRemoved,
      minObservedCount: selection.minCount,
    };
  });

  return {
    targets,
    sourceProfiles,
    mergeMetadata: {
      profileCount: sources.length,
      tableSizes: [...new Set(sources.map((source) => source.tableSize))]
        .sort((left, right) => left - right),
      selectedExactKeyOccurrences,
      selectedTargetVariantOccurrences,
      mergedExactKeys,
      mergedTargetVariants: targets.length,
      duplicateTargetVariantsRemoved: selectedTargetVariantOccurrences - targets.length,
    },
  };
}

function legacySourceProfile(source) {
  return {
    schema: source.schema,
    version: source.version,
    sha256: source.sha256,
    observedDecisions: source.observedDecisions,
    uniqueExactKeys: source.uniqueExactKeys,
    selectedExactKeys: source.selectedExactKeys,
    selectedTargetVariants: source.selectedTargetVariants,
    minObservedCount: source.minObservedCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const profileSources = await loadProfileSources(args.profiles);
  const profileRaiseCaps = new Set(
    profileSources.map((source) => source.maxRaisesPerStreet),
  );
  if (profileRaiseCaps.size !== 1) {
    throw new RangeError('all profiles must use the same maxRaisesPerStreet abstraction');
  }
  const profileRaiseCap = profileSources[0].maxRaisesPerStreet;
  const maxRaisesPerStreet = args.maxRaises == null ? profileRaiseCap : args.maxRaises;
  if (maxRaisesPerStreet !== profileRaiseCap) {
    throw new RangeError('maxRaises must match the profile action abstraction');
  }
  let {
    targets,
    sourceProfiles,
    mergeMetadata,
  } = mergeProfileTargets(profileSources, args, maxRaisesPerStreet);
  let tournamentValueModel = null;
  let tournamentValueSource = null;
  let tournamentMaxUncertainty = args.tournamentMaxUncertainty;
  if (args.tournamentValueModel) {
    const modelPath = resolve(args.tournamentValueModel);
    const reportPath = resolve(args.tournamentValueReport);
    const [modelText, reportText] = await Promise.all([
      readFile(modelPath, 'utf8'),
      readFile(reportPath, 'utf8'),
    ]);
    const modelArtifact = JSON.parse(modelText);
    compileTournamentValueModel(modelArtifact);
    const quality = JSON.parse(reportText);
    if (quality?.schema !== 'qyj-tournament-value-quality-v1'
      || quality?.version !== 1
      || quality?.promotion?.passed !== true) {
      throw new RangeError('tournament value quality report has not passed formal promotion');
    }
    const modelSha256 = createHash('sha256').update(modelText).digest('hex');
    if (quality?.model?.sha256 !== modelSha256) {
      throw new RangeError('tournament value model SHA-256 does not match quality report');
    }
    const reportedMaxUncertainty = Number(quality?.calibration?.maxUncertainty);
    if (!Number.isFinite(reportedMaxUncertainty) || reportedMaxUncertainty < 0) {
      throw new RangeError('quality report has no valid uncertainty gate');
    }
    if (tournamentMaxUncertainty == null) {
      tournamentMaxUncertainty = reportedMaxUncertainty;
    } else if (tournamentMaxUncertainty > reportedMaxUncertainty) {
      throw new RangeError('tournament uncertainty override may not loosen the promoted report gate');
    }
    tournamentValueModel = modelArtifact;
    tournamentValueSource = {
      schema: modelArtifact.schema,
      version: modelArtifact.version,
      sha256: modelSha256,
      qualityReportSha256: createHash('sha256').update(reportText).digest('hex'),
      datasetSha256: quality?.dataset?.sha256 || null,
    };
  }
  let tournamentRootFilter = null;
  if (args.filterUnsafeTournamentRoots) {
    if (!tournamentValueModel) {
      throw new TypeError('--filter-unsafe-tournament-roots requires a tournament value model');
    }
    const filtered = filterTournamentSafeTargets(targets, {
      maxRaisesPerStreet,
      beliefTemperature: args.beliefTemperature,
      tournamentValueModel,
      tournamentValueMaxUncertainty: tournamentMaxUncertainty ?? undefined,
      tournamentValueMaxOodScore: args.tournamentMaxOodScore,
      tournamentValueFallbackShareScale: args.tournamentFallbackShareScale,
    });
    if (!filtered.targets.length) {
      throw new RangeError('all selected tournament roots failed promoted-model preflight');
    }
    targets = [...filtered.targets];
    tournamentRootFilter = filtered.diagnostics;
    mergeMetadata = {
      ...mergeMetadata,
      tournamentRootFilter,
    };
  }
  if (args.tournamentPreflightReport) {
    const reportPath = resolve(args.tournamentPreflightReport);
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify({
      schema: 'qyj-targeted-tournament-root-preflight-v1',
      version: 1,
      tournamentValueSource,
      sourceProfiles,
      sourceProfileMerge: mergeMetadata,
      diagnostics: tournamentRootFilter,
    }, null, 2)}\n`, 'utf8');
  }
  if (args.preflightOnly) {
    if (!args.quiet) console.log(JSON.stringify(tournamentRootFilter, null, 2));
    return;
  }
  const checkpoint = trainTargetedBlueprint(targets, {
    visitsPerTarget: args.visits,
    seed: args.seed,
    maxRaisesPerStreet,
    blendWeight: args.blendWeight,
    maxDepth: args.maxDepth,
    beliefTemperature: args.beliefTemperature,
    tournamentValueModel,
    tournamentValueMaxUncertainty: tournamentMaxUncertainty ?? undefined,
    tournamentValueMaxOodScore: args.tournamentMaxOodScore,
    tournamentValueFallbackShareScale: args.tournamentFallbackShareScale,
  });
  if (tournamentValueModel && checkpoint.metadata?.terminalUtility?.enabled !== true) {
    throw new RangeError(
      'promoted tournament value failed the merged-profile checkpoint root gate; no mixed/fallback checkpoint was written',
    );
  }
  checkpoint.metadata.sourceProfiles = sourceProfiles;
  checkpoint.metadata.sourceProfileMerge = mergeMetadata;
  if (sourceProfiles.length === 1) {
    checkpoint.metadata.sourceProfile = legacySourceProfile(sourceProfiles[0]);
  }
  checkpoint.metadata.publication = {
    exactOnly: true,
    minExactVisits: args.visits,
    backoffPublished: false,
  };
  if (tournamentValueSource) checkpoint.metadata.tournamentValueSource = tournamentValueSource;
  compileBlueprintCheckpoint(checkpoint);
  const output = resolve(args.output);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  if (!args.quiet) {
    console.log(`targetKeys=${checkpoint.metadata.targetCount}`
      + ` targetVariants=${targets.length} visitsPerTarget=${args.visits}`);
    if (sourceProfiles.length === 1) {
      console.log(`profileSha256=${sourceProfiles[0].sha256}`);
    } else {
      for (const source of sourceProfiles) {
        console.log(`profileSha256[t${source.tableSize}]=${source.sha256}`);
      }
    }
  }
  console.log(`saved=${output}`);
  console.log(JSON.stringify({
    infoSets: Object.keys(checkpoint.infosets).length,
    targetCount: checkpoint.metadata.targetCount,
    visitsPerTarget: checkpoint.metadata.visitsPerTarget,
    utilitySamples: checkpoint.metadata.utilitySamples,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
