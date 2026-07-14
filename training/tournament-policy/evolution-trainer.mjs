export function gaussian(rng) {
  if (typeof rng !== 'function') throw new TypeError('gaussian requires an RNG function');
  const left = Math.max(Number.MIN_VALUE, rng());
  const right = rng();
  return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * right);
}

export function sampleEvolutionPopulation(mean, sigma, {
  populationSize = 12,
  rng = Math.random,
  maxAbsWeight = 4,
} = {}) {
  if (!Array.isArray(mean) || !mean.length || !Array.isArray(sigma)
    || sigma.length !== mean.length || mean.some((value) => !Number.isFinite(Number(value)))
    || sigma.some((value) => !(Number(value) > 0))
    || !Number.isSafeInteger(populationSize) || populationSize < 2 || populationSize % 2 !== 0
    || !(maxAbsWeight > 0)) throw new TypeError('invalid evolution population options');
  const result = [];
  for (let pair = 0; pair < populationSize / 2; pair++) {
    const noise = mean.map(() => gaussian(rng));
    for (const sign of [1, -1]) {
      result.push(Object.freeze(mean.map((value, index) => Math.max(
        -maxAbsWeight,
        Math.min(maxAbsWeight, Number(value) + sign * Number(sigma[index]) * noise[index]),
      ))));
    }
  }
  return Object.freeze(result);
}

export function updateEvolutionDistribution(population, evaluations, {
  eliteFraction = 0.25,
  smoothing = 0.55,
  minSigma = 0.04,
  maxSigma = 1.25,
} = {}) {
  if (!Array.isArray(population) || !population.length || !Array.isArray(evaluations)
    || evaluations.length !== population.length
    || evaluations.some((row) => !Number.isFinite(Number(row?.fitness)))
    || !(eliteFraction > 0 && eliteFraction <= 0.5)
    || !(smoothing > 0 && smoothing <= 1) || !(minSigma > 0)
    || !(maxSigma >= minSigma)) throw new TypeError('invalid evolution update inputs');
  const dimensions = population[0].length;
  if (!dimensions || population.some((weights) => !Array.isArray(weights)
    || weights.length !== dimensions || weights.some((value) => !Number.isFinite(Number(value))))) {
    throw new TypeError('evolution population dimensions are inconsistent');
  }
  const eliteCount = Math.max(2, Math.floor(population.length * eliteFraction));
  const ranked = evaluations.map((evaluation, index) => ({ evaluation, weights: population[index] }))
    .sort((left, right) => Number(right.evaluation.fitness) - Number(left.evaluation.fitness)
      || left.evaluation.id.localeCompare(right.evaluation.id));
  const elites = ranked.slice(0, eliteCount);
  const targetMean = Array.from({ length: dimensions }, (_, dimension) => (
    elites.reduce((sum, elite) => sum + elite.weights[dimension], 0) / elites.length
  ));
  const targetSigma = Array.from({ length: dimensions }, (_, dimension) => {
    const variance = elites.reduce(
      (sum, elite) => sum + ((elite.weights[dimension] - targetMean[dimension]) ** 2), 0,
    ) / elites.length;
    return Math.max(minSigma, Math.min(maxSigma, Math.sqrt(variance)));
  });
  return Object.freeze({
    eliteCount,
    elites: Object.freeze(elites.map((elite) => Object.freeze({ ...elite.evaluation }))),
    targetMean: Object.freeze(targetMean),
    targetSigma: Object.freeze(targetSigma),
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function scoreEvolutionResults(matches, {
  candidateId,
  baselineId,
  tableSize,
} = {}) {
  const rankAdvantages = [];
  const hpAdvantages = [];
  let decisions = 0;
  let changes = 0;
  for (const match of matches || []) {
    const candidate = match.results?.find((result) => result.entryId === candidateId);
    const baseline = match.results?.find((result) => result.entryId === baselineId);
    if (!candidate || !baseline || match.errorCount !== 0
      || (!match.fullSchedule && !match.naturalEarlyFinish)) continue;
    const rankValue = (rank) => (Number(tableSize) + 1 - 2 * Number(rank))
      / Math.max(1, Number(tableSize) - 1);
    rankAdvantages.push(rankValue(candidate.rank) - rankValue(baseline.rank));
    hpAdvantages.push(Math.tanh((Number(candidate.hp) - Number(baseline.hp)) / 1500));
    decisions += Number(candidate.actions?.onlineResolverDecisions) || 0;
    changes += Number(candidate.actions?.onlineResolverActionChanges) || 0;
  }
  if (!rankAdvantages.length) throw new RangeError(`no complete matches for ${candidateId}`);
  const rankAdvantage = mean(rankAdvantages);
  const hpAdvantage = mean(hpAdvantages);
  const dualFloor = Math.min(rankAdvantage, hpAdvantage);
  // The weaker objective dominates selection. This prevents a large rank gain
  // from paying for a negative HP direction (or vice versa).
  const fitness = 0.25 * ((rankAdvantage + hpAdvantage) / 2) + 0.75 * dualFloor;
  return Object.freeze({
    rankAdvantage,
    hpAdvantage,
    dualFloor,
    fitness,
    matches: rankAdvantages.length,
    decisions,
    changes,
    changeRate: decisions ? changes / decisions : 0,
  });
}

export function scoreEvolutionSeedGroups(matchGroups, options = {}, {
  uncertaintyZ = 0.75,
} = {}) {
  if (!Array.isArray(matchGroups) || matchGroups.length < 2
    || !(uncertaintyZ >= 0 && uncertaintyZ <= 3)) {
    throw new TypeError('robust evolution scoring requires at least two seed groups');
  }
  const rows = matchGroups.map((matches) => scoreEvolutionResults(matches, options));
  const moments = (field) => {
    const values = rows.map((row) => Number(row[field]));
    const meanValue = mean(values);
    const variance = values.reduce((sum, item) => sum + ((item - meanValue) ** 2), 0)
      / Math.max(1, values.length - 1);
    return { mean: meanValue, se: Math.sqrt(variance / values.length) };
  };
  const rank = moments('rankAdvantage');
  const hp = moments('hpAdvantage');
  const robustRank = rank.mean - uncertaintyZ * rank.se;
  const robustHp = hp.mean - uncertaintyZ * hp.se;
  const dualFloor = Math.min(robustRank, robustHp);
  const fitness = 0.25 * ((robustRank + robustHp) / 2) + 0.75 * dualFloor;
  const decisions = rows.reduce((sum, row) => sum + row.decisions, 0);
  const changes = rows.reduce((sum, row) => sum + row.changes, 0);
  return Object.freeze({
    rankAdvantage: rank.mean,
    hpAdvantage: hp.mean,
    rankStandardError: rank.se,
    hpStandardError: hp.se,
    robustRank,
    robustHp,
    dualFloor,
    fitness,
    seedGroups: rows.length,
    matches: rows.reduce((sum, row) => sum + row.matches, 0),
    decisions,
    changes,
    changeRate: decisions ? changes / decisions : 0,
  });
}
