#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import {
  compileTournamentValueModel,
  projectTournamentValueTrainingSamples,
  serializeTournamentValueModel,
  trainTournamentValueModel,
} from './tournament-value/model.js';
import {
  TOURNAMENT_VALUE_QUALITY_SCHEMA,
  evaluateTournamentValueSplit,
  stressTournamentValueModel,
  tournamentValuePromotionGate,
} from './tournament-value/quality.mjs';

const DATASET_SCHEMA = 'qyj-tournament-value-dataset-v2';

function usage() {
  return `QYJ public tournament continuation-value trainer and held-out gate

Usage:
  node training/train-tournament-value.mjs --dataset PATH [options]

Options:
  --dataset PATH           V2 public dataset (required)
  --output PATH            Canonical model JSON
  --report PATH            Held-out quality report JSON
  --ensemble N             Bootstrap ridge members (default: 11)
  --ridge N                Ridge penalty (default: 0.02)
  --seed TEXT              Deterministic model/bootstrap seed
  --bootstrap N            Test cluster-bootstrap draws (default: 2000)
  --confidence N           CI confidence (default: 0.95)
  --max-uncertainty N      Inference acceptance gate (default: 0.75)
  --stress-states N        Held-out public states to stress (default: 100000)
  --pilot                  Small-sample diagnostics; can never promote
  --require-pass           Exit 2 unless every formal gate passes
  --help                   Show this help

Validation calibrates residual uncertainty only. Coefficients use train groups;
promotion metrics and stress gates use untouched test groups.`;
}

function number(value, flag) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new TypeError(`${flag} requires a finite number`);
  return parsed;
}

function parseArgs(argv) {
  const args = {
    dataset: null,
    output: 'training/checkpoints/qyj-tournament-value-v2.json',
    report: 'training/checkpoints/qyj-tournament-value-v2-quality.json',
    ensembleSize: 11,
    ridge: 0.02,
    seed: 'qyj-tournament-value-v2',
    bootstrapIterations: 2_000,
    confidence: 0.95,
    maxUncertainty: 0.75,
    stressStates: 100_000,
    pilot: false,
    requirePass: false,
  };
  const after = (index, flag) => {
    if (index + 1 >= argv.length) throw new TypeError(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (flag === '--pilot') args.pilot = true;
    else if (flag === '--require-pass') args.requirePass = true;
    else if (flag === '--dataset') args.dataset = after(index++, flag);
    else if (flag === '--output') args.output = after(index++, flag);
    else if (flag === '--report') args.report = after(index++, flag);
    else if (flag === '--ensemble') args.ensembleSize = number(after(index++, flag), flag);
    else if (flag === '--ridge') args.ridge = number(after(index++, flag), flag);
    else if (flag === '--seed') args.seed = after(index++, flag);
    else if (flag === '--bootstrap') {
      args.bootstrapIterations = number(after(index++, flag), flag);
    } else if (flag === '--confidence') args.confidence = number(after(index++, flag), flag);
    else if (flag === '--max-uncertainty') {
      args.maxUncertainty = number(after(index++, flag), flag);
    } else if (flag === '--stress-states') args.stressStates = number(after(index++, flag), flag);
    else throw new TypeError(`Unknown option ${flag}`);
  }
  if (!args.dataset) throw new TypeError('--dataset is required');
  for (const key of ['ensembleSize', 'bootstrapIterations', 'stressStates']) {
    if (!Number.isSafeInteger(args[key]) || args[key] < 1) {
      throw new RangeError(`${key} must be a positive safe integer`);
    }
  }
  if (args.ensembleSize < 2 || args.ensembleSize > 64) {
    throw new RangeError('ensembleSize must be in 2..64');
  }
  if (!(args.ridge >= 1e-8)) throw new RangeError('ridge must be at least 1e-8');
  if (!(args.confidence > 0 && args.confidence < 1)) {
    throw new RangeError('confidence must be in 0..1');
  }
  if (!(args.maxUncertainty >= 0)) throw new RangeError('maxUncertainty must be non-negative');
  return args;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

async function writeJson(path, value) {
  const output = resolve(path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(canonical(value), null, 2)}\n`, 'utf8');
  return output;
}

function validateDataset(dataset) {
  if (!dataset || typeof dataset !== 'object' || dataset.schema !== DATASET_SCHEMA) {
    throw new TypeError(`dataset must use ${DATASET_SCHEMA}`);
  }
  for (const split of ['train', 'validation', 'test']) {
    if (!Array.isArray(dataset.splits?.[split]) || !dataset.splits[split].length) {
      throw new RangeError(`dataset.splits.${split} must be non-empty`);
    }
  }
  return dataset;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const datasetPath = resolve(args.dataset);
  const datasetText = await readFile(datasetPath, 'utf8');
  const dataset = validateDataset(JSON.parse(datasetText));
  const train = projectTournamentValueTrainingSamples(dataset.splits.train);
  if (train.continuationCount < 1) throw new RangeError('train split has no continuation rows');
  const rawModel = trainTournamentValueModel(train.rows, {
    clusterIds: train.clusterIds,
    ensembleSize: args.ensembleSize,
    ridge: args.ridge,
    seed: args.seed,
  });

  // Validation does not alter coefficients. It only widens the uncertainty
  // floor when truly held-out residuals exceed cluster-OOB training error.
  const rawValidation = evaluateTournamentValueSplit(rawModel, dataset.splits.validation, {
    bootstrapIterations: Math.min(200, args.bootstrapIterations),
    confidence: args.confidence,
    seed: `${args.seed}|validation`,
    maxUncertainty: Number.MAX_VALUE,
  });
  const calibratedArtifact = structuredClone(rawModel);
  calibratedArtifact.training.residualStd = Math.max(
    calibratedArtifact.training.residualStd,
    rawValidation.modelRmse,
  );
  const model = compileTournamentValueModel(calibratedArtifact);
  const validation = evaluateTournamentValueSplit(model, dataset.splits.validation, {
    bootstrapIterations: Math.min(200, args.bootstrapIterations),
    confidence: args.confidence,
    seed: `${args.seed}|validation-calibrated`,
    maxUncertainty: args.maxUncertainty,
  });
  const test = evaluateTournamentValueSplit(model, dataset.splits.test, {
    bootstrapIterations: args.bootstrapIterations,
    confidence: args.confidence,
    seed: `${args.seed}|test`,
    maxUncertainty: args.maxUncertainty,
  });
  const stress = stressTournamentValueModel(model, dataset.splits.test, {
    maxStates: args.stressStates,
  });
  const promotion = tournamentValuePromotionGate({
    trainSamples: dataset.splits.train,
    validationSamples: dataset.splits.validation,
    testSamples: dataset.splits.test,
    testMetrics: test,
    stress,
    pilot: args.pilot,
    // Passing null (rather than allowing the quality helper's compatibility
    // default) makes a missing dataset declaration fail closed.
    deploymentTables: dataset.config?.tables ?? null,
  });

  const modelText = `${serializeTournamentValueModel(calibratedArtifact, 2)}\n`;
  const modelSha256 = sha256(modelText);
  const report = {
    schema: TOURNAMENT_VALUE_QUALITY_SCHEMA,
    version: 1,
    model: {
      schema: calibratedArtifact.schema,
      version: calibratedArtifact.version,
      sha256: modelSha256,
      training: calibratedArtifact.training,
    },
    dataset: {
      schema: dataset.schema,
      sha256: sha256(datasetText),
      tables: dataset.config?.tables || [],
      summary: dataset.summary,
      collection: {
        groupSecretId: dataset.collection?.groupSecretId || null,
        focalStrategies: dataset.collection?.focalStrategies || [],
        rawReplaySeedIncluded: dataset.collection?.rawReplaySeedIncluded === true,
      },
    },
    projection: {
      train: {
        inputCount: train.inputCount,
        continuationCount: train.continuationCount,
        droppedExact: train.droppedExact,
      },
    },
    calibration: {
      source: 'validation-rmse-max-cluster-oob',
      clusterOobResidualStd: rawModel.training.residualStd,
      validationRmse: rawValidation.modelRmse,
      installedResidualStd: calibratedArtifact.training.residualStd,
      maxUncertainty: args.maxUncertainty,
    },
    validation,
    test,
    stress,
    promotion,
    limitations: [
      'continuation value is policy-distribution-specific and no-skill only',
      'public cross-hand opponent-style sufficient statistics are not yet value-model features',
      'multiplayer targeted MCCFR remains an approximation without Nash guarantees',
    ],
  };

  const modelOutput = resolve(args.output);
  await mkdir(dirname(modelOutput), { recursive: true });
  await writeFile(modelOutput, modelText, 'utf8');
  const reportOutput = await writeJson(args.report, report);
  console.log(JSON.stringify({
    model: modelOutput,
    report: reportOutput,
    modelSha256,
    trainRows: train.continuationCount,
    promotion: report.promotion,
    test: report.test.byTable,
    stress: report.stress,
  }, null, 2));
  if (args.requirePass && !promotion.passed) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
