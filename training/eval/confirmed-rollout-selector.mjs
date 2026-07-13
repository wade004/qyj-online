import { createHash } from 'node:crypto';

export const CONFIRMED_ROLLOUT_SELECTOR_SCHEMA = 'qyj-confirmed-rollout-selector-v1';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function buildConfirmedRolloutSelector(guidances, { minLowerBound = 5 } = {}) {
  const sources = Array.isArray(guidances) ? guidances : [guidances];
  const records = [];
  for (const source of sources) {
    if (source?.schema !== 'qyj-public-belief-rollout-guidance-v1'
      || source?.selectionMode !== 'fresh-seed-confirmation-of-pilot-accepted-roots'
      || ![6, 9].includes(Number(source.tableSize))) {
      throw new TypeError('confirmed selector requires fresh-seed confirmation guidance');
    }
    for (const [informationSetKey, record] of Object.entries(source.records || {})) {
      const selected = record.rollout?.selected;
      if (!record.rollout?.accepted || !selected
        || Number(selected.lowerBound) < minLowerBound
        || selected.actionKey !== record.rollout.actionKey) continue;
      records.push(Object.freeze({
        recordSha256: createHash('sha256').update(
          `${source.tableSize}|${informationSetKey}|${selected.actionKey}`,
        ).digest('hex'),
        tableSize: Number(source.tableSize),
        informationSetKey,
        baseActionKey: record.baseActionKey,
        actionKey: selected.actionKey,
        mean: Number(selected.mean),
        lowerBound: Number(selected.lowerBound),
        clusterCount: Number(record.rollout.clusterCount),
        sourceGroups: Object.freeze([...new Set(record.sourceGroups || [])].sort()),
      }));
    }
  }
  records.sort((left, right) => left.tableSize - right.tableSize
    || left.informationSetKey.localeCompare(right.informationSetKey));
  const byTable = Object.fromEntries([6, 9].map((tableSize) => [tableSize, {
    records: records.filter((record) => record.tableSize === tableSize).length,
    sourceGroups: new Set(records.filter((record) => record.tableSize === tableSize)
      .flatMap((record) => record.sourceGroups)).size,
  }]));
  const validationPassed = [6, 9].every(
    (tableSize) => byTable[tableSize].records >= 10 && byTable[tableSize].sourceGroups >= 4,
  );
  return Object.freeze({
    schema: CONFIRMED_ROLLOUT_SELECTOR_SCHEMA,
    version: 1,
    mode: 'offline-evaluation-only',
    confirmationSha256: Object.freeze(sources.map(sha).sort()),
    thresholds: Object.freeze({ minLowerBound, minClusterCount: 24 }),
    records: Object.freeze(records),
    validation: Object.freeze({
      method: 'fresh-seed-24-cluster-exact-state-confirmation',
      records: records.length,
      byTable,
      passed: validationPassed,
    }),
    promotionEligible: false,
    promotionBlockers: Object.freeze([
      ...(validationPassed ? [] : ['insufficient-confirmed-exact-roots']),
      'requires-fresh-real-league-coverage-and-positive-paired-utility',
      'offline-evaluation-only',
    ]),
  });
}

export function validateConfirmedRolloutSelector(raw) {
  if (raw?.schema !== CONFIRMED_ROLLOUT_SELECTOR_SCHEMA || Number(raw?.version) !== 1
    || raw?.mode !== 'offline-evaluation-only' || raw?.validation?.passed !== true
    || !Array.isArray(raw?.records) || Number(raw?.thresholds?.minClusterCount) < 24) {
    throw new TypeError('unsupported or unvalidated confirmed rollout selector');
  }
  return raw;
}

export function evaluateConfirmedRolloutSelector(selector, {
  tableSize,
  informationSetKey,
  baseActionKey,
  legalActionKeys,
} = {}) {
  const source = validateConfirmedRolloutSelector(selector);
  const legal = new Set(legalActionKeys || []);
  const record = source.records.find((candidate) => (
    candidate.tableSize === Number(tableSize)
    && candidate.informationSetKey === informationSetKey
    && candidate.baseActionKey === baseActionKey
    && legal.has(candidate.actionKey)
  ));
  if (!record) return Object.freeze({ eligible: false, reason: 'no-confirmed-exact-root' });
  return Object.freeze({
    eligible: true,
    reason: null,
    actionKey: record.actionKey,
    lowerBound: record.lowerBound,
    mean: record.mean,
    clusterCount: record.clusterCount,
    recordSha256: record.recordSha256,
  });
}
