#!/usr/bin/env node

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { runLeague } from '../training/eval/league.mjs';
import { listStrategies } from '../training/eval/strategies.mjs';
import { compileBlueprintCheckpoint } from '../js/game/blueprint-policy.js';
import {
  compileCompactResidualPolicy,
  predictCompactResidualPolicy,
} from '../js/game/blueprint-residual-policy.js';
import {
  ExactInfosetReachProfiler,
  exactInfosetProfileSecretId,
  validateExactInfosetProfile,
} from '../training/blueprint/target-profile.js';
import {
  CompactResidualBaseRowCollector,
  CompactResidualSuccessorCollector,
  CompactResidualRowCollector,
} from '../training/blueprint/residual-data.mjs';
import { validateResidualInterventionSelector } from '../training/blueprint/residual-selector.mjs';

function help() {
  console.log(`QYJ AI evaluation league

Usage:
  npm run eval:ai -- [options]

Options:
  --table <6|9>             Table size (default: 6)
  --seed <text>             Reproducible base seed (default: qyj-eval-v1)
  --seeds <n>               Independent seed clusters (default: 2; promotion: >=8)
  --rotations <full|n>      Circular seat rotations (default: full)
  --mirror / --no-mirror    Include reflected seat order (default: mirror)
  --lineup <a,b,...>        Strategy keys; short lists repeat to fill the table
  --blueprint <path>        Evaluate one MCCFR checkpoint as strategy "blueprint"
  --residual-candidate <path>  Offline-only sampled residual candidate model
  --residual-selector <path>   Optional sparse intervention selector bound to the model
  --skills                  Enable heroes, passives and active-skill policy
  --bootstrap <n>           Cluster-bootstrap iterations (default: 2000)
  --confidence <0..1>       Confidence level (default: 0.95)
  --candidate <key>         Promotion candidate (default: qyz)
  --baseline <key>          Promotion baseline (default: qyz-tight)
  --gate-metric <rank|hp|both>  Positive paired advantage required (default: rank)
  --min-paired-seeds <n>    Minimum independent seeds to promote (default: 8)
  --min-improvement <n>     Required lower confidence bound (default: 0)
  --min-blueprint-hit-rate <n>  Minimum checkpoint key-hit rate (default: 0.01)
  --min-blueprint-mean-influence <n>  Minimum mean strategy influence (default: 0.01)
  --min-blueprint-action-change-rate <n>  Minimum action-change rate (default: 0.01)
  --exact-infoset-profile <path>  Write a separate raw abstract-key reach profile
  --profile-strategies <a,b>  Strategies to profile (default: blueprint, or qyz)
  --profile-top <n>          Maximum retained exact keys (default: 50000)
  --profile-max-raises <0..3>  Key encoder raise cap (default: 3)
  --profile-group-secret <ENV>  HMAC secret environment variable for promotable V2 provenance
  --residual-rows <path>     Write complete QYZ/base and exact-target action vectors
  --residual-base-rows <path>  Write complete QYZ vectors for every profiled decision
  --residual-successors <path> Write option-induced next-decision transitions
  --residual-include-backoff  Include labeled, reliability-weighted backoff targets
  --residual-shadow <path>   Evaluate a compact residual model without changing actions
  --residual-shadow-report <path>  Write all-decision shadow coverage diagnostics
  --calibrate-beliefs       Score public-action beliefs against held-out simulator holes
  --belief-temperature <0..1>  Calibration/training likelihood temperature (default: 0.5)
  --no-gate                 Skip promotion gate and candidate/baseline crossover
  --require-promotion       Exit with code 2 unless the promotion gate passes
  --json <path|->           Write the complete machine-readable report
  --json-only               Print only JSON to stdout (implies --json -)
  --quick                   One seed, one rotation, no mirror, 200 bootstrap draws
  --list-strategies         Print available strategy keys
  --help                    Show this help

Examples:
  npm run eval:ai -- --quick --seed smoke-1
  npm run eval:ai -- --table 9 --seeds 20 --seed candidate-v3 --json reports/v3.json
  npm run eval:ai -- --blueprint training/checkpoints/qyj-blueprint.json --seeds 20
  npm run eval:ai -- --quick --exact-infoset-profile training/profiles/smoke.json
  npm run eval:ai -- --seeds 30 --candidate qyz --baseline qyz-tight --require-promotion
`);
}

function parseArgs(argv) {
  const options = {
    tableSize: 6,
    baseSeed: 'qyj-eval-v1',
    seedCount: 2,
    rotations: 'full',
    mirror: true,
    skillsEnabled: false,
    bootstrapIterations: 2000,
    confidence: 0.95,
    promotionGate: {},
    jsonPath: null,
    jsonOnly: false,
    requirePromotion: false,
    blueprintPath: null,
    residualCandidatePath: null,
    residualSelectorPath: null,
    explicitLineup: false,
    explicitCandidate: false,
    explicitBaseline: false,
    exactInfosetProfilePath: null,
    profileStrategies: null,
    profileTop: 50_000,
    profileMaxRaises: 3,
    profileGroupSecretEnv: null,
    residualRowsPath: null,
    residualBaseRowsPath: null,
    residualSuccessorPath: null,
    residualIncludeBackoff: false,
    residualShadowPath: null,
    residualShadowReportPath: null,
    profileFlagsUsed: false,
    beliefCalibration: false,
    beliefTemperature: 0.5,
  };
  const valueAfter = (index, flag) => {
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    return argv[index + 1];
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--list-strategies') options.listStrategies = true;
    else if (flag === '--mirror') options.mirror = true;
    else if (flag === '--no-mirror') options.mirror = false;
    else if (flag === '--skills') options.skillsEnabled = true;
    else if (flag === '--no-skills') options.skillsEnabled = false;
    else if (flag === '--no-gate') options.promotionGate = false;
    else if (flag === '--calibrate-beliefs') options.beliefCalibration = true;
    else if (flag === '--require-promotion') options.requirePromotion = true;
    else if (flag === '--json-only') {
      options.jsonOnly = true;
      options.jsonPath = '-';
    } else if (flag === '--quick') {
      options.seedCount = 1;
      options.rotations = 1;
      options.mirror = false;
      options.bootstrapIterations = 200;
    } else if (flag === '--table') options.tableSize = Number(valueAfter(index++, flag));
    else if (flag === '--seed') options.baseSeed = valueAfter(index++, flag);
    else if (flag === '--seeds') options.seedCount = Number(valueAfter(index++, flag));
    else if (flag === '--rotations') {
      const value = valueAfter(index++, flag);
      options.rotations = value === 'full' ? 'full' : Number(value);
    } else if (flag === '--lineup') {
      options.lineup = valueAfter(index++, flag).split(',').map((item) => item.trim()).filter(Boolean);
      options.explicitLineup = true;
    } else if (flag === '--blueprint') {
      options.blueprintPath = valueAfter(index++, flag);
    } else if (flag === '--residual-candidate') {
      options.residualCandidatePath = valueAfter(index++, flag);
    } else if (flag === '--residual-selector') {
      options.residualSelectorPath = valueAfter(index++, flag);
    } else if (flag === '--bootstrap') {
      options.bootstrapIterations = Number(valueAfter(index++, flag));
    } else if (flag === '--confidence') options.confidence = Number(valueAfter(index++, flag));
    else if (flag === '--candidate') {
      options.promotionGate ||= {};
      options.promotionGate.candidate = valueAfter(index++, flag);
      options.explicitCandidate = true;
    } else if (flag === '--baseline') {
      options.promotionGate ||= {};
      options.promotionGate.baseline = valueAfter(index++, flag);
      options.explicitBaseline = true;
    } else if (flag === '--gate-metric') {
      options.promotionGate ||= {};
      options.promotionGate.metric = valueAfter(index++, flag);
    } else if (flag === '--min-paired-seeds') {
      options.promotionGate ||= {};
      options.promotionGate.minPairedSeeds = Number(valueAfter(index++, flag));
    } else if (flag === '--min-improvement') {
      options.promotionGate ||= {};
      options.promotionGate.minImprovement = Number(valueAfter(index++, flag));
    } else if (flag === '--min-blueprint-hit-rate') {
      options.promotionGate ||= {};
      options.promotionGate.minBlueprintHitRate = Number(valueAfter(index++, flag));
    } else if (flag === '--min-blueprint-mean-influence') {
      options.promotionGate ||= {};
      options.promotionGate.minBlueprintMeanInfluence = Number(valueAfter(index++, flag));
    } else if (flag === '--min-blueprint-action-change-rate') {
      options.promotionGate ||= {};
      options.promotionGate.minBlueprintActionChangeRate = Number(valueAfter(index++, flag));
    } else if (flag === '--exact-infoset-profile') {
      options.exactInfosetProfilePath = valueAfter(index++, flag);
    } else if (flag === '--profile-strategies') {
      options.profileStrategies = valueAfter(index++, flag)
        .split(',').map((item) => item.trim()).filter(Boolean);
      options.profileFlagsUsed = true;
    } else if (flag === '--profile-top') {
      options.profileTop = Number(valueAfter(index++, flag));
      options.profileFlagsUsed = true;
    } else if (flag === '--profile-max-raises') {
      options.profileMaxRaises = Number(valueAfter(index++, flag));
      options.profileFlagsUsed = true;
    } else if (flag === '--profile-group-secret') {
      options.profileGroupSecretEnv = valueAfter(index++, flag);
      options.profileFlagsUsed = true;
    } else if (flag === '--residual-rows') {
      options.residualRowsPath = valueAfter(index++, flag);
    } else if (flag === '--residual-base-rows') {
      options.residualBaseRowsPath = valueAfter(index++, flag);
    } else if (flag === '--residual-successors') {
      options.residualSuccessorPath = valueAfter(index++, flag);
    } else if (flag === '--residual-include-backoff') {
      options.residualIncludeBackoff = true;
    } else if (flag === '--residual-shadow') {
      options.residualShadowPath = valueAfter(index++, flag);
    } else if (flag === '--residual-shadow-report') {
      options.residualShadowReportPath = valueAfter(index++, flag);
    } else if (flag === '--belief-temperature') {
      options.beliefTemperature = Number(valueAfter(index++, flag));
    } else if (flag === '--json') options.jsonPath = valueAfter(index++, flag);
    else throw new Error(`Unknown option: ${flag}`);
  }
  return options;
}

function fixed(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function ciText(metric, digits = 2) {
  return `${fixed(metric.mean, digits)} [${fixed(metric.low, digits)}, ${fixed(metric.high, digits)}]`;
}

function printHumanReport(report) {
  const confidenceLabel = `${fixed(report.config.confidence * 100, 1)}% CI`;
  console.log('\nQYJ AI 强度评测联赛');
  console.log(
    `桌型=${report.config.tableSize}  独立种子=${report.config.seedCount}`
      + `  对局=${report.matchCount}  镜像=${report.config.mirror ? '是' : '否'}`
      + `  技能=${report.config.skillsEnabled ? '开启' : '关闭（中性扑克基准）'}`,
  );
  console.log(
    `打满12手=${report.fullScheduleMatches}/${report.matchCount}`
      + `  合法提前终局=${report.naturalEarlyFinishMatches}`,
  );
  if (report.config.promotionCrossover) {
    console.log(
      `候选↔基线交叉=${report.config.promotionCrossover.enabled ? '是' : '否'}`
        + `  原槽位=${report.config.promotionCrossover.baseVariants}`
        + `  互换槽位=${report.config.promotionCrossover.swappedVariants}`,
    );
  }
  console.log(`基础种子=${report.config.baseSeed}  耗时=${fixed(report.durationMs / 1000, 1)}s`);
  if (report.config.blueprint) {
    console.log(
      `蓝图=${report.config.blueprint.source || report.config.blueprint.schema}`
        + `  infosets=${report.config.blueprint.size}`
        + `  blend=${fixed(report.config.blueprint.blendWeight, 3)}`,
    );
  }
  console.table(report.summary.map((row) => ({
    strategy: row.strategy,
    samples: row.samples,
    seeds: row.seedClusters,
    [`rank ${confidenceLabel}`]: ciText(row.meanRank),
    [`win ${confidenceLabel}`]: ciText(row.firstPlaceRate, 3),
    [`survive ${confidenceLabel}`]: ciText(row.survivalRate, 3),
    [`HP ${confidenceLabel}`]: ciText(row.meanHp, 1),
    'F/K/C/R/A': [
      row.actions.fold,
      row.actions.check,
      row.actions.call,
      row.actions.raise,
      row.actions.allin,
    ].join('/'),
    aggression: fixed(row.aggressionRate, 3),
    'bp usable/exact': row.actions.blueprintDecisions
      ? `${fixed(row.blueprintHitRate, 3)}/${fixed(row.exactHitRate, 3)}`
      : '-',
    'bp E/H/P/S/O #': row.actions.blueprintDecisions
      ? [
          row.blueprintBackoffCounts?.exact,
          row.blueprintBackoffCounts?.history,
          row.blueprintBackoffCounts?.position,
          row.blueprintBackoffCounts?.strategic,
          row.blueprintBackoffCounts?.population,
        ].map((value) => Number(value) || 0).join('/')
      : '-',
    'bp H/P/S rate': row.actions.blueprintDecisions
      ? [
          row.blueprintBackoffRates?.history,
          row.blueprintBackoffRates?.position,
          row.blueprintBackoffRates?.strategic,
        ].map((value) => fixed(value || 0, 3)).join('/')
      : '-',
    'bp w|hit': row.actions.blueprintDecisions
      ? fixed(row.blueprintConditionalWeight, 3)
      : '-',
    'bp int/chg': row.actions.blueprintDecisions
      ? `${fixed(row.interventionRate, 3)}/${fixed(row.actionChangeRate, 3)}`
      : '-',
    'bp TV/inf': row.actions.blueprintDecisions
      ? `${fixed(row.meanPolicyTV, 3)}/${fixed(row.meanInfluence, 3)}`
      : '-',
    'res cov/chg': row.actions.residualDecisions
      ? `${fixed(row.residualCoverage, 3)}/${fixed(row.residualActionChangeRate, 3)}`
      : '-',
    'res TV': row.actions.residualDecisions ? fixed(row.residualMeanPolicyTV, 4) : '-',
  })));
  if (report.promotion) {
    const gate = report.promotion;
    console.log(
      `晋级门：${gate.candidate} vs ${gate.baseline}，指标=${gate.metric}，`
        + `配对种子=${gate.pairedSeeds}/${gate.minPairedSeeds || '-'}，`
        + `结果=${gate.passed ? 'PASS' : 'FAIL'} (${gate.reason})`,
    );
    if (gate.rankAdvantage) {
      console.log(`  排名优势（正数更好）: ${ciText(gate.rankAdvantage)}`);
      console.log(`  HP优势（正数更好）: ${ciText(gate.hpAdvantage, 1)}`);
    }
    if (gate.statisticalReason) {
      console.log(`  原始统计结论（仅诊断）: ${gate.statisticalReason}`);
    }
    if (gate.blueprintCoverage) {
      console.log(
        `  蓝图作用门: usableHit=${fixed(gate.blueprintCoverage.observedHitRate, 3)}`
          + ` >= ${fixed(gate.blueprintCoverage.minHitRate, 3)}, `
          + `exactHit=${fixed(gate.blueprintCoverage.exactHitRate, 3)}, `
          + `influence=${fixed(gate.blueprintCoverage.meanInfluence, 3)}`
          + ` >= ${fixed(gate.blueprintCoverage.minMeanInfluence, 3)}, `
          + `actionChange=${fixed(gate.blueprintCoverage.actionChangeRate, 3)}`
          + ` >= ${fixed(gate.blueprintCoverage.minActionChangeRate, 3)}`,
      );
      console.log(
        `  条件权重=${fixed(gate.blueprintCoverage.blueprintConditionalWeight, 4)}, `
          + `intervention=${fixed(gate.blueprintCoverage.interventionRate, 3)}, `
          + `policyTV=${fixed(gate.blueprintCoverage.meanPolicyTV, 3)}`,
      );
      console.log(
        `  层级计数 E/H/P/S/O=${[
          gate.blueprintCoverage.backoffCounts?.exact,
          gate.blueprintCoverage.backoffCounts?.history,
          gate.blueprintCoverage.backoffCounts?.position,
          gate.blueprintCoverage.backoffCounts?.strategic,
          gate.blueprintCoverage.backoffCounts?.population,
        ].map((value) => Number(value) || 0).join('/')}，回退率 H/P/S/O=${[
          gate.blueprintCoverage.backoffRates?.history,
          gate.blueprintCoverage.backoffRates?.position,
          gate.blueprintCoverage.backoffRates?.strategic,
          gate.blueprintCoverage.backoffRates?.population,
        ].map((value) => fixed(value || 0, 3)).join('/')}`,
      );
    }
    if (gate.residualCoverage) {
      const residual = gate.residualCoverage;
      console.log(
        `  Residual materiality: coverage=${fixed(residual.observedCoverage, 3)}`
          + ` >= ${fixed(residual.minCoverage, 3)}, TV=${fixed(residual.meanPolicyTV, 4)}`
          + ` >= ${fixed(residual.minMeanPolicyTV, 4)}, actionChange=${fixed(residual.actionChangeRate, 4)}`
          + ` >= ${fixed(residual.minActionChangeRate, 4)}`,
      );
    }
    if (gate.eligibilityBlockers?.length) {
      console.log(`  未通过项: ${gate.eligibilityBlockers.join(', ')}`);
    }
  }
  if (report.beliefCalibration) {
    const calibration = report.beliefCalibration;
    console.log(
      `Belief calibration: ${calibration.passed ? 'PASS' : 'FAIL'}`
        + ` temperature=${fixed(calibration.likelihoodTemperature, 2)}`
        + ` conditioned=${calibration.conditioned.samples}`
        + ` logloss gain=${fixed(calibration.conditioned.logLossImprovement, 5)}`
        + ` brier gain=${fixed(calibration.conditioned.brierImprovement, 5)}`,
    );
  }
  for (const warning of report.warnings) console.warn(`警告: ${warning}`);
}

let options;
let profileSourceGroupSecret = null;
let profileSourceGroupSecretId = null;
try {
  options = parseArgs(process.argv.slice(2));
  if (options.help) {
    help();
    process.exit(0);
  }
  if (options.listStrategies) {
    console.table(listStrategies());
    process.exit(0);
  }
  if (options.blueprintPath) {
    const checkpointPath = path.resolve(process.cwd(), options.blueprintPath);
    const checkpointText = fs.readFileSync(checkpointPath, 'utf8');
    const parsed = JSON.parse(checkpointText);
    options.blueprintCheckpoint = compileBlueprintCheckpoint(parsed);
    options.blueprintSource = checkpointPath;
    options.blueprintSha256 = createHash('sha256').update(checkpointText).digest('hex');
    if (!options.explicitLineup) {
      options.lineup = [
        'blueprint', 'qyz', 'qyz-tight', 'qyz-aggressive',
        'calling-station', 'random-legal', 'check-fold', 'qyz-loose', 'calling-station',
      ];
    } else if (!options.lineup.includes('blueprint')) {
      throw new Error('--blueprint requires "blueprint" in an explicit --lineup');
    }
    if (options.promotionGate !== false) {
      if (!options.explicitCandidate) options.promotionGate.candidate = 'blueprint';
      if (!options.explicitBaseline) options.promotionGate.baseline = 'qyz';
    }
  } else if (options.lineup?.includes('blueprint')) {
    throw new Error('strategy "blueprint" requires --blueprint <checkpoint.json>');
  }
  if (options.residualCandidatePath) {
    const modelPath = path.resolve(process.cwd(), options.residualCandidatePath);
    const modelText = fs.readFileSync(modelPath, 'utf8');
    options.residualPolicyModel = compileCompactResidualPolicy(JSON.parse(modelText));
    options.residualPolicySource = modelPath;
    options.residualPolicySha256 = createHash('sha256').update(modelText).digest('hex');
    if (!options.explicitLineup) {
      options.lineup = [
        'residual-candidate', 'qyz', 'qyz-tight', 'qyz-aggressive',
        'calling-station', 'random-legal', 'check-fold', 'qyz-loose', 'qyz-bluffer',
      ];
    } else if (!options.lineup.includes('residual-candidate')) {
      throw new Error('--residual-candidate requires residual-candidate in --lineup');
    }
    if (options.promotionGate !== false) {
      if (!options.explicitCandidate) options.promotionGate.candidate = 'residual-candidate';
      if (!options.explicitBaseline) options.promotionGate.baseline = 'qyz';
    }
  } else if (options.lineup?.includes('residual-candidate')) {
    throw new Error('strategy residual-candidate requires --residual-candidate <model.json>');
  }
  if (options.residualSelectorPath) {
    if (!options.residualPolicyModel) {
      throw new Error('--residual-selector requires --residual-candidate');
    }
    const selectorPath = path.resolve(process.cwd(), options.residualSelectorPath);
    const selectorText = fs.readFileSync(selectorPath, 'utf8');
    options.residualInterventionSelector = validateResidualInterventionSelector(
      JSON.parse(selectorText), { residualModelSha256: options.residualPolicySha256 },
    );
    options.residualSelectorSource = selectorPath;
    options.residualSelectorSha256 = createHash('sha256').update(selectorText).digest('hex');
  }
  if (options.promotionGate && typeof options.promotionGate === 'object') {
    for (const [key, label] of [
      ['minBlueprintHitRate', '--min-blueprint-hit-rate'],
      ['minBlueprintMeanInfluence', '--min-blueprint-mean-influence'],
      ['minBlueprintActionChangeRate', '--min-blueprint-action-change-rate'],
    ]) {
      if (options.promotionGate[key] == null) continue;
      if (!Number.isFinite(options.promotionGate[key])
        || options.promotionGate[key] < 0
        || options.promotionGate[key] > 1) {
        throw new Error(`${label} must be a finite number between 0 and 1`);
      }
    }
  }
  if (options.profileFlagsUsed && !options.exactInfosetProfilePath) {
    throw new Error('--profile-* options require --exact-infoset-profile <path>');
  }
  if (options.residualRowsPath) {
    if (!options.exactInfosetProfilePath || !options.blueprintCheckpoint) {
      throw new Error('--residual-rows requires --exact-infoset-profile and --blueprint');
    }
    if (!options.profileGroupSecretEnv) {
      throw new Error('--residual-rows requires --profile-group-secret provenance');
    }
    if (options.residualRowsPath === '-') {
      throw new Error('--residual-rows requires a file path, not stdout');
    }
  }
  if (options.residualBaseRowsPath
    && (!options.exactInfosetProfilePath || !options.profileGroupSecretEnv)) {
    throw new Error('--residual-base-rows requires exact profile and source-group provenance');
  }
  if (options.residualSuccessorPath
    && (!options.exactInfosetProfilePath || !options.profileGroupSecretEnv
      || !options.residualCandidatePath || !options.residualSelectorPath)) {
    throw new Error('--residual-successors requires exact profile, provenance, residual candidate and selector');
  }
  if (options.residualShadowPath) {
    if (!options.exactInfosetProfilePath || !options.residualShadowReportPath) {
      throw new Error('--residual-shadow requires --exact-infoset-profile and --residual-shadow-report');
    }
    const modelText = fs.readFileSync(path.resolve(options.residualShadowPath), 'utf8');
    options.residualShadowModel = compileCompactResidualPolicy(JSON.parse(modelText));
    options.residualShadowSha256 = createHash('sha256').update(modelText).digest('hex');
  } else if (options.residualShadowReportPath) {
    throw new Error('--residual-shadow-report requires --residual-shadow');
  }
  if (!Number.isFinite(options.beliefTemperature)
    || options.beliefTemperature < 0 || options.beliefTemperature > 1) {
    throw new Error('--belief-temperature must be a finite number in 0..1');
  }
  if (options.beliefCalibration && options.skillsEnabled) {
    throw new Error('--calibrate-beliefs requires skills to be disabled');
  }
  if (options.exactInfosetProfilePath) {
    if (options.skillsEnabled) {
      throw new Error('--exact-infoset-profile requires skills to be disabled');
    }
    if (options.exactInfosetProfilePath === '-') {
      throw new Error('--exact-infoset-profile requires a file path, not stdout');
    }
    if (!Number.isSafeInteger(options.profileTop)
      || options.profileTop < 1
      || options.profileTop > 1_000_000) {
      throw new Error('--profile-top must be an integer in 1..1000000');
    }
    if (!Number.isSafeInteger(options.profileMaxRaises)
      || options.profileMaxRaises < 0
      || options.profileMaxRaises > 3) {
      throw new Error('--profile-max-raises must be an integer in 0..3');
    }
    if (options.profileGroupSecretEnv != null) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.profileGroupSecretEnv)) {
        throw new Error('--profile-group-secret must name a valid environment variable');
      }
      profileSourceGroupSecret = process.env[options.profileGroupSecretEnv];
      if (profileSourceGroupSecret == null || profileSourceGroupSecret === '') {
        throw new Error('--profile-group-secret environment variable is missing or empty');
      }
      profileSourceGroupSecretId = exactInfosetProfileSecretId(profileSourceGroupSecret);
    }
    options.profileStrategies ||= [options.blueprintCheckpoint ? 'blueprint' : 'qyz'];
    const availableStrategies = new Set(listStrategies().map((strategy) => strategy.key));
    if (!options.profileStrategies.length
      || options.profileStrategies.some((strategy) => !availableStrategies.has(strategy))) {
      throw new Error('--profile-strategies contains an unknown or empty strategy');
    }
    if (options.jsonPath && options.jsonPath !== '-') {
      const profilePath = path.resolve(process.cwd(), options.exactInfosetProfilePath);
      const reportPath = path.resolve(process.cwd(), options.jsonPath);
      if (profilePath === reportPath) {
        throw new Error('profile and ordinary JSON report must use different paths');
      }
    }
    if (options.blueprintSource
      && path.resolve(process.cwd(), options.exactInfosetProfilePath)
        === path.resolve(options.blueprintSource)) {
      throw new Error('profile output must not overwrite the blueprint checkpoint');
    }
  }
} catch (error) {
  console.error(error.message);
  help();
  process.exit(1);
}

const {
  jsonPath,
  jsonOnly,
  requirePromotion,
  blueprintPath: _blueprintPath,
  residualCandidatePath: _residualCandidatePath,
  residualSelectorPath: _residualSelectorPath,
  exactInfosetProfilePath,
  profileTop,
  profileStrategies,
  profileMaxRaises,
  profileGroupSecretEnv: _profileGroupSecretEnv,
  residualRowsPath,
  residualBaseRowsPath,
  residualSuccessorPath,
  residualIncludeBackoff,
  residualShadowPath,
  residualShadowReportPath,
  residualShadowModel,
  residualShadowSha256,
  profileFlagsUsed: _profileFlagsUsed,
  explicitLineup: _explicitLineup,
  explicitCandidate: _explicitCandidate,
  explicitBaseline: _explicitBaseline,
  ...leagueOptions
} = options;
const exactInfosetProfiler = exactInfosetProfilePath
  ? new ExactInfosetReachProfiler({
      top: profileTop,
      sourceGroupSecretId: profileSourceGroupSecretId,
    }) : null;
const residualCollector = residualRowsPath
  ? new CompactResidualRowCollector({
      sourceGroupSecretId: profileSourceGroupSecretId,
      exactOnly: !residualIncludeBackoff,
    })
  : null;
const residualBaseCollector = residualBaseRowsPath
  ? new CompactResidualBaseRowCollector({ sourceGroupSecretId: profileSourceGroupSecretId })
  : null;
const residualSuccessorCollector = residualSuccessorPath
  ? new CompactResidualSuccessorCollector({ sourceGroupSecretId: profileSourceGroupSecretId })
  : null;
const residualShadowTotals = residualShadowModel ? {
  decisions: 0, accepted: 0, shadowTV: 0, wouldChange: 0,
  fallbackFeatures: 0, reasons: {},
} : null;
if (exactInfosetProfiler) {
  leagueOptions.onExactInfosetProfile = (record) => exactInfosetProfiler.observe(record);
  if (residualSuccessorCollector) {
    leagueOptions.onResidualSuccessor = (record) => residualSuccessorCollector.observe(record);
  }
  if (residualCollector || residualBaseCollector || residualShadowTotals) {
    leagueOptions.onResidualPolicyProfile = (record) => {
    residualCollector?.observe(record);
    residualBaseCollector?.observe(record);
    if (residualShadowTotals) {
      const prediction = predictCompactResidualPolicy(residualShadowModel, {
        informationSetKey: record.exactKey,
        baseDistribution: record.baseStrategy,
        basePolicyContract: residualShadowModel.contracts.basePolicyContract,
        baseStyleKey: residualShadowModel.contracts.baseStyleKey,
      });
      residualShadowTotals.decisions++;
      if (prediction.accepted) {
        residualShadowTotals.accepted++;
        residualShadowTotals.shadowTV += prediction.shadowTV;
        residualShadowTotals.fallbackFeatures += prediction.fallbackFeatureCount || 0;
        if (prediction.shadowWouldChange) residualShadowTotals.wouldChange++;
      } else {
        residualShadowTotals.reasons[prediction.reason]
          = (residualShadowTotals.reasons[prediction.reason] || 0) + 1;
      }
    }
    };
  }
  leagueOptions.profileStrategies = profileStrategies;
  leagueOptions.profileMaxRaises = profileMaxRaises;
  if (profileSourceGroupSecret != null) {
    leagueOptions.profileSourceGroupSecret = profileSourceGroupSecret;
  }
}
if (!jsonOnly) {
  leagueOptions.onProgress = ({ completed, total, matchId, durationMs }) => {
    console.error(`[${completed}/${total}] ${matchId} ${fixed(durationMs / 1000, 1)}s`);
  };
}

try {
  const report = runLeague(leagueOptions);
  if (exactInfosetProfiler) {
    const profile = validateExactInfosetProfile(exactInfosetProfiler.finalize({
      tableSize: report.config.tableSize,
      skillsEnabled: report.config.skillsEnabled,
      maxRaisesPerStreet: profileMaxRaises,
      strategies: profileStrategies,
      matches: report.matchCount,
      fullScheduleMatches: report.fullScheduleMatches,
      checkpointSha256: report.config.blueprint?.sha256 || null,
    }));
    const profileJson = `${JSON.stringify(profile, null, 2)}\n`;
    const profileOutputPath = path.resolve(process.cwd(), exactInfosetProfilePath);
    fs.mkdirSync(path.dirname(profileOutputPath), { recursive: true });
    fs.writeFileSync(profileOutputPath, profileJson, 'utf8');
    const profileSha256 = createHash('sha256').update(profileJson).digest('hex');
    console.error(
      `Exact infoset profile: ${profileOutputPath}`
        + ` sha256=${profileSha256}`
        + ` decisions=${profile.collection.observedDecisions}`
        + ` unique=${profile.collection.uniqueExactKeys}`
        + ` retained=${profile.collection.retainedExactKeys}`
        + ` sourceGroups=${profile.collection.sourceGroupCount}`
        + ` promotable=${profile.collection.promotionEligible ? 'yes' : 'no'}`,
    );
    if (residualCollector) {
      const summary = residualCollector.summary();
      const residualOutputPath = path.resolve(process.cwd(), residualRowsPath);
      let residual;
      if (summary.exactRoots > 0) residual = residualCollector.finalize({
        profileSources: [{
          sha256: profileSha256,
          tableSize: report.config.tableSize,
          sourceGroups: profile.collection.sourceGroups,
        }],
      });
      else residual = {
        schema: 'qyj-compact-residual-collection-diagnostic-v1',
        version: 1,
        promotionEligible: false,
        blockers: ['no-compatible-target-rows'],
        sourceGroupSecretId: profile.collection.sourceGroupSecretId,
        profileSha256,
        tableSize: report.config.tableSize,
        summary,
      };
      const residualJson = `${JSON.stringify(residual, null, 2)}\n`;
      fs.mkdirSync(path.dirname(residualOutputPath), { recursive: true });
      fs.writeFileSync(residualOutputPath, residualJson, 'utf8');
      const residualSha256 = createHash('sha256').update(residualJson).digest('hex');
      console.error(
        `Residual rows: ${residualOutputPath} sha256=${residualSha256}`
          + ` roots=${summary.exactRoots} decisions=${summary.retainedDecisions}`,
      );
    }
    if (residualBaseCollector) {
      const baseRows = residualBaseCollector.finalize({
        profileSources: [{
          sha256: profileSha256,
          tableSize: report.config.tableSize,
          sourceGroups: profile.collection.sourceGroups,
        }],
      });
      const outputPath = path.resolve(process.cwd(), residualBaseRowsPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(baseRows, null, 2)}\n`, 'utf8');
      const summary = residualBaseCollector.summary();
      console.error(`Residual base rows: ${outputPath} rows=${summary.rows} decisions=${summary.decisions}`);
    }
    if (residualSuccessorCollector) {
      const successors = residualSuccessorCollector.finalize({
        profileSources: [{
          sha256: profileSha256,
          tableSize: report.config.tableSize,
          sourceGroups: profile.collection.sourceGroups,
        }],
      });
      const outputPath = path.resolve(process.cwd(), residualSuccessorPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(successors, null, 2)}\n`, 'utf8');
      const summary = residualSuccessorCollector.summary();
      console.error(`Residual successors: ${outputPath} rows=${summary.rows}`
        + ` attempts=${summary.attempts} continuations=${summary.continuations}`
        + ` aborts=${summary.aborts}`);
    }
    if (residualShadowTotals) {
      const shadowReport = {
        schema: 'qyj-compact-residual-shadow-evaluation-v1',
        version: 1,
        mode: 'shadow-only',
        modelSha256: residualShadowSha256,
        profileSha256,
        tableSize: report.config.tableSize,
        sourceGroups: profile.collection.sourceGroups,
        sourceGroupSecretId: profile.collection.sourceGroupSecretId,
        decisions: residualShadowTotals.decisions,
        acceptedDecisions: residualShadowTotals.accepted,
        coverage: residualShadowTotals.decisions
          ? residualShadowTotals.accepted / residualShadowTotals.decisions : 0,
        meanShadowTV: residualShadowTotals.accepted
          ? residualShadowTotals.shadowTV / residualShadowTotals.accepted : 0,
        shadowWouldChangeRate: residualShadowTotals.decisions
          ? residualShadowTotals.wouldChange / residualShadowTotals.decisions : 0,
        meanFallbackFeatures: residualShadowTotals.accepted
          ? residualShadowTotals.fallbackFeatures / residualShadowTotals.accepted : 0,
        rejectionReasons: residualShadowTotals.reasons,
        promotionEligible: false,
        promotionBlockers: [
          'diagnostic-seed-count-below-formal-threshold',
          'independent-action-advantage-coverage-below-formal-threshold',
          'hierarchical-category-fallback-requires-calibration',
          'shadow-only-schema-cannot-deploy',
        ],
      };
      const outputPath = path.resolve(process.cwd(), residualShadowReportPath);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, `${JSON.stringify(shadowReport, null, 2)}\n`, 'utf8');
      console.error(`Residual shadow report: ${outputPath} coverage=${fixed(shadowReport.coverage, 4)}`);
    }
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (!jsonOnly) printHumanReport(report);
  if (jsonPath === '-') process.stdout.write(json);
  else if (jsonPath) {
    const outputPath = path.resolve(process.cwd(), jsonPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, 'utf8');
    console.log(`JSON 报告: ${outputPath}`);
  }
  if (requirePromotion && !report.promotion?.passed) process.exitCode = 2;
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
