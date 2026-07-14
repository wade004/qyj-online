import {
  compileTournamentValueModel,
  normalizedFinalRankValue,
  predictTournamentValue,
  projectTournamentValueTrainingSamples,
} from './model.js';
import { projectJointTournamentValues } from './targeted-utility.js';
import { createSeededRng, deriveSeed } from '../eval/rng.mjs';

export const TOURNAMENT_VALUE_QUALITY_SCHEMA = 'qyj-tournament-value-quality-v1';

// These are the table sizes the production Engine can deploy.  A formal
// value artifact is shared by both modes, so silently evaluating only one
// table (or accepting a future/typo table) would make the aggregate promotion
// result materially misleading.
export const TOURNAMENT_VALUE_DEPLOYMENT_TABLES = Object.freeze([6, 9]);

export const DEFAULT_TOURNAMENT_VALUE_QUALITY_THRESHOLDS = Object.freeze({
  minTrainGroupsPerTable: 500,
  minValidationGroupsPerTable: 100,
  minTestGroupsPerTable: 100,
  minRelativeRmseImprovement: 0.05,
  minCoverage: 0.95,
  maxClipRate: 0.001,
  maxMonotonicViolations: 0,
  maxJointSumError: 1e-9,
});

function mean(values) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be finite`);
  return number;
}

function integer(value, label, minimum = 0) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return number;
}

/** Positive-stack ordering baseline with midpoint treatment for exact ties. */
export function currentStackRankBaseline(state) {
  const focal = finite(state?.focalStack, 'state.focalStack');
  if (!Array.isArray(state?.opponentStacks) || state.opponentStacks.length < 1) {
    throw new TypeError('state.opponentStacks must be a non-empty array');
  }
  const greater = state.opponentStacks.filter((stack) => Number(stack) > focal).length;
  const equal = state.opponentStacks.filter((stack) => Number(stack) === focal).length;
  const expectedRank = 1 + greater + equal / 2;
  return 1 - (2 * (expectedRank - 1)) / (Number(state.tableSize) - 1);
}

function continuationRows(samples) {
  if (!Array.isArray(samples)) throw new TypeError('samples must be an array');
  const rows = [];
  for (const sample of samples) {
    const projected = projectTournamentValueTrainingSamples([sample]);
    if (!projected.rows.length) continue;
    rows.push({
      sample,
      row: projected.rows[0],
      group: projected.clusterIds[0],
    });
  }
  return rows;
}

function metricSummary(rows) {
  const modelSquared = rows.map((row) => row.modelError ** 2);
  const baselineSquared = rows.map((row) => row.baselineError ** 2);
  const modelAbsolute = rows.map((row) => Math.abs(row.modelError));
  const baselineAbsolute = rows.map((row) => Math.abs(row.baselineError));
  const modelRmse = Math.sqrt(mean(modelSquared));
  const baselineRmse = Math.sqrt(mean(baselineSquared));
  const accepted = rows.filter((row) => row.accepted);
  const acceptedRmse = accepted.length
    ? Math.sqrt(mean(accepted.map((row) => row.modelError ** 2))) : null;
  return Object.freeze({
    samples: rows.length,
    groups: new Set(rows.map((row) => row.group)).size,
    accepted: accepted.length,
    coverage: rows.length ? accepted.length / rows.length : 0,
    clipped: rows.filter((row) => row.prediction.clipped).length,
    clipRate: rows.length
      ? rows.filter((row) => row.prediction.clipped).length / rows.length : 0,
    modelRmse,
    baselineRmse,
    rmseImprovement: baselineRmse - modelRmse,
    relativeRmseImprovement: baselineRmse > 0
      ? (baselineRmse - modelRmse) / baselineRmse : 0,
    modelMae: mean(modelAbsolute),
    baselineMae: mean(baselineAbsolute),
    acceptedModelRmse: acceptedRmse,
    meanUncertainty: mean(rows.map((row) => row.prediction.uncertainty)),
  });
}

function clusterBootstrapImprovement(rows, {
  iterations,
  confidence,
  seed,
}) {
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.group)) byGroup.set(row.group, []);
    byGroup.get(row.group).push(row);
  }
  const groups = [...byGroup.values()];
  const point = metricSummary(rows).rmseImprovement;
  if (groups.length < 2 || iterations < 2) {
    return Object.freeze({ mean: point, low: point, high: point, iterations, groups: groups.length });
  }
  const random = createSeededRng(deriveSeed(seed));
  const draws = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let modelSquared = 0;
    let baselineSquared = 0;
    let count = 0;
    for (let draw = 0; draw < groups.length; draw++) {
      const group = groups[Math.floor(random() * groups.length)];
      for (const row of group) {
        modelSquared += row.modelError ** 2;
        baselineSquared += row.baselineError ** 2;
        count++;
      }
    }
    draws.push(Math.sqrt(baselineSquared / count) - Math.sqrt(modelSquared / count));
  }
  const tail = (1 - confidence) / 2;
  return Object.freeze({
    mean: mean(draws),
    low: quantile(draws, tail),
    high: quantile(draws, 1 - tail),
    iterations,
    groups: groups.length,
  });
}

export function evaluateTournamentValueSplit(modelOrArtifact, samples, options = {}) {
  const model = compileTournamentValueModel(modelOrArtifact);
  const iterations = integer(options.bootstrapIterations ?? 2_000, 'bootstrapIterations', 1);
  const confidence = finite(options.confidence ?? 0.95, 'confidence');
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError('confidence must be in 0..1');
  }
  const seed = String(options.seed ?? 'qyj-tournament-value-quality-v1');
  const maxUncertainty = finite(
    options.maxUncertainty ?? Number.MAX_VALUE,
    'maxUncertainty',
  );
  const evaluated = continuationRows(samples).map(({ sample, row, group }) => {
    const prediction = predictTournamentValue(model, row.state);
    const baseline = currentStackRankBaseline(row.state);
    return Object.freeze({
      sample,
      row,
      group,
      prediction,
      modelError: prediction.mean - row.value,
      baselineError: baseline - row.value,
      accepted: !prediction.ood && prediction.uncertainty <= maxUncertainty,
    });
  });
  if (!evaluated.length) throw new RangeError('split contains no continuation samples');
  const tableSizes = [...new Set(evaluated.map((row) => row.row.state.tableSize))]
    .sort((left, right) => left - right);
  const byTable = Object.fromEntries(tableSizes.map((tableSize) => {
    const rows = evaluated.filter((row) => row.row.state.tableSize === tableSize);
    return [tableSize, Object.freeze({
      ...metricSummary(rows),
      rmseImprovementCi: clusterBootstrapImprovement(rows, {
        iterations,
        confidence,
        seed: `${seed}|table=${tableSize}`,
      }),
    })];
  }));
  return Object.freeze({
    ...metricSummary(evaluated),
    bootstrapIterations: iterations,
    confidence,
    byTable: Object.freeze(byTable),
  });
}

function focalStateFromRing(state, focalPosition, ring = state.liveStacksFromButton) {
  const focalStack = ring[focalPosition];
  const deadCount = state.tableSize - ring.length;
  return {
    tableSize: state.tableSize,
    round: state.round,
    maxRounds: state.maxRounds,
    bigBlind: state.bigBlind,
    focalStack,
    opponentStacks: [
      ...ring.filter((_, index) => index !== focalPosition),
      ...Array(deadCount).fill(0),
    ].sort((left, right) => right - left),
    liveStacksFromButton: [...ring],
    focalPosition,
  };
}

function survivorTargetSum(aliveCount, tableSize) {
  let sum = 0;
  for (let rank = 1; rank <= aliveCount; rank++) {
    sum += normalizedFinalRankValue(rank, tableSize);
  }
  return sum;
}

export function stressTournamentValueModel(modelOrArtifact, samples, options = {}) {
  const model = compileTournamentValueModel(modelOrArtifact);
  const maxStates = integer(options.maxStates ?? 100_000, 'maxStates', 1);
  const rows = continuationRows(samples);
  const unique = new Map();
  for (const { row } of rows) {
    const state = row.state;
    const key = JSON.stringify([
      state.tableSize, state.round, state.bigBlind, state.liveStacksFromButton,
    ]);
    if (!unique.has(key)) unique.set(key, state);
    if (unique.size >= maxStates) break;
  }
  let jointStates = 0;
  let jointAccepted = 0;
  let maxRawSumError = 0;
  let maxProjectedSumError = 0;
  let clippedPredictions = 0;
  let predictions = 0;
  let monotonicTests = 0;
  let monotonicViolations = 0;
  let worstMonotonicDelta = 0;
  for (const state of unique.values()) {
    jointStates++;
    const ring = state.liveStacksFromButton;
    const joint = ring.map((stack, focalPosition) => {
      const focalState = focalStateFromRing(state, focalPosition);
      const prediction = predictTournamentValue(model, focalState);
      predictions++;
      if (prediction.clipped) clippedPredictions++;
      return { seat: focalPosition, stack, state: focalState, prediction };
    });
    if (joint.every((entry) => !entry.prediction.ood)) {
      jointAccepted++;
      const target = survivorTargetSum(ring.length, state.tableSize);
      const raw = joint.reduce((sum, entry) => sum + entry.prediction.mean, 0);
      maxRawSumError = Math.max(maxRawSumError, Math.abs(raw - target));
      const projected = projectJointTournamentValues(joint.map((entry) => ({
        seat: entry.seat,
        stack: entry.stack,
        value: entry.prediction.mean,
      })), state.tableSize);
      const projectedSum = [...projected.values.values()]
        .reduce((sum, value) => sum + value, 0);
      maxProjectedSumError = Math.max(
        maxProjectedSumError,
        Math.abs(projectedSum - target),
      );
    }

    // Local same-player transfer checks. Relative positions stay fixed while
    // one live opponent transfers a small positive chip amount to the focal.
    for (let focal = 0; focal < ring.length; focal++) {
      const opponent = (focal + 1) % ring.length;
      const amount = Math.min(
        Math.max(1, Math.floor(state.bigBlind / 2)),
        Math.floor(ring[opponent] / 2),
      );
      if (!(amount > 0)) continue;
      const improvedRing = [...ring];
      improvedRing[focal] += amount;
      improvedRing[opponent] -= amount;
      const beforeState = focalStateFromRing(state, focal, ring);
      const afterState = focalStateFromRing(state, focal, improvedRing);
      const before = predictTournamentValue(model, beforeState);
      const after = predictTournamentValue(model, afterState);
      if (before.ood || after.ood) continue;
      monotonicTests++;
      const delta = after.mean - before.mean;
      if (delta < -1e-9) {
        monotonicViolations++;
        worstMonotonicDelta = Math.min(worstMonotonicDelta, delta);
      }
    }
  }
  return Object.freeze({
    uniqueStates: unique.size,
    jointStates,
    jointAccepted,
    jointCoverage: jointStates ? jointAccepted / jointStates : 0,
    maxRawSumError,
    maxProjectedSumError,
    predictions,
    clippedPredictions,
    clipRate: predictions ? clippedPredictions / predictions : 0,
    monotonicTests,
    monotonicViolations,
    worstMonotonicDelta,
  });
}

function groupCountsByTable(samples) {
  const rows = continuationRows(samples);
  const byTable = {};
  for (const { row, group } of rows) {
    const table = row.state.tableSize;
    byTable[table] ||= new Set();
    byTable[table].add(group);
  }
  return Object.fromEntries(Object.entries(byTable).map(([table, groups]) => (
    [table, groups.size]
  )));
}

function deploymentTableContract(rawTables) {
  const blockers = [];
  if (!Array.isArray(rawTables)) {
    blockers.push('deployment-tables-missing');
    return Object.freeze({
      tables: Object.freeze([]),
      blockers: Object.freeze(blockers),
    });
  }
  const tables = [];
  const seen = new Set();
  for (const rawTable of rawTables) {
    if (!Number.isSafeInteger(rawTable)) {
      blockers.push('deployment-tables-invalid');
      continue;
    }
    if (seen.has(rawTable)) {
      blockers.push(`duplicate-deployment-table-${rawTable}`);
      continue;
    }
    seen.add(rawTable);
    tables.push(rawTable);
    if (!TOURNAMENT_VALUE_DEPLOYMENT_TABLES.includes(rawTable)) {
      blockers.push(`unknown-deployment-table-${rawTable}`);
    }
  }
  for (const table of TOURNAMENT_VALUE_DEPLOYMENT_TABLES) {
    if (!seen.has(table)) blockers.push(`missing-deployment-table-${table}`);
  }
  return Object.freeze({
    tables: Object.freeze([...tables].sort((left, right) => left - right)),
    blockers: Object.freeze([...new Set(blockers)]),
  });
}

function observedTableContract(...sources) {
  const tables = new Set();
  let invalid = false;
  for (const source of sources) {
    for (const rawTable of Object.keys(source || {})) {
      const table = Number(rawTable);
      if (!Number.isSafeInteger(table) || String(table) !== String(rawTable)) {
        invalid = true;
      } else {
        tables.add(table);
      }
    }
  }
  const blockers = invalid ? ['observed-tables-invalid'] : [];
  for (const table of [...tables].sort((left, right) => left - right)) {
    if (!TOURNAMENT_VALUE_DEPLOYMENT_TABLES.includes(table)) {
      blockers.push(`unknown-observed-table-${table}`);
    }
  }
  return Object.freeze({
    tables: Object.freeze([...tables].sort((left, right) => left - right)),
    blockers: Object.freeze(blockers),
  });
}

export function tournamentValuePromotionGate({
  trainSamples,
  validationSamples,
  testSamples,
  testMetrics,
  stress,
  pilot = false,
  thresholds: overrides = {},
  deploymentTables = TOURNAMENT_VALUE_DEPLOYMENT_TABLES,
} = {}) {
  const thresholds = Object.freeze({
    ...DEFAULT_TOURNAMENT_VALUE_QUALITY_THRESHOLDS,
    ...overrides,
  });
  const blockers = [];
  if (pilot) blockers.push('pilot-mode');
  const trainGroups = groupCountsByTable(trainSamples);
  const validationGroups = groupCountsByTable(validationSamples);
  const testGroups = groupCountsByTable(testSamples);
  const deployment = deploymentTableContract(deploymentTables);
  blockers.push(...deployment.blockers);
  const observed = observedTableContract(
    trainGroups,
    validationGroups,
    testGroups,
    testMetrics?.byTable,
  );
  blockers.push(...observed.blockers);
  // Always gate every production table, including a table omitted from the
  // dataset declaration or all three data partitions.  This is intentionally
  // stricter than iterating the observed union, which made absence invisible.
  for (const table of TOURNAMENT_VALUE_DEPLOYMENT_TABLES) {
    const prefix = `table-${table}`;
    if ((trainGroups[table] || 0) < thresholds.minTrainGroupsPerTable) {
      blockers.push(`${prefix}-train-groups`);
    }
    if ((validationGroups[table] || 0) < thresholds.minValidationGroupsPerTable) {
      blockers.push(`${prefix}-validation-groups`);
    }
    if ((testGroups[table] || 0) < thresholds.minTestGroupsPerTable) {
      blockers.push(`${prefix}-test-groups`);
    }
    const metrics = testMetrics?.byTable?.[table];
    if (!metrics) {
      blockers.push(`${prefix}-missing-test-metrics`);
      continue;
    }
    if (metrics.relativeRmseImprovement < thresholds.minRelativeRmseImprovement) {
      blockers.push(`${prefix}-rmse-improvement`);
    }
    if (!(metrics.rmseImprovementCi.low > 0)) blockers.push(`${prefix}-rmse-ci`);
    if (metrics.coverage < thresholds.minCoverage) blockers.push(`${prefix}-coverage`);
    if (metrics.clipRate >= thresholds.maxClipRate) blockers.push(`${prefix}-clip-rate`);
  }
  if (stress.monotonicViolations > thresholds.maxMonotonicViolations) {
    blockers.push('monotonicity');
  }
  if (stress.maxProjectedSumError > thresholds.maxJointSumError) {
    blockers.push('joint-sum-error');
  }
  if (stress.monotonicTests < 1 || stress.jointAccepted < 1) {
    blockers.push('stress-coverage');
  }
  return Object.freeze({
    passed: blockers.length === 0,
    reason: blockers[0] || 'passed',
    blockers: Object.freeze([...new Set(blockers)]),
    thresholds,
    deploymentTables: deployment.tables,
    requiredDeploymentTables: TOURNAMENT_VALUE_DEPLOYMENT_TABLES,
    observedTables: observed.tables,
    independentGroups: Object.freeze({
      train: Object.freeze(trainGroups),
      validation: Object.freeze(validationGroups),
      test: Object.freeze(testGroups),
    }),
  });
}
