import {
  blueprintActionKeysForMask,
} from '../../js/game/blueprint-policy.js';
import { compactResidualFeatures } from '../../js/game/blueprint-residual-policy.js';

export const COMPACT_RESIDUAL_ROWS_SCHEMA = 'qyj-compact-residual-policy-rows-v2';
export const COMPACT_RESIDUAL_ROWS_VERSION = 2;

const PROFILE_SCHEMA = 'qyj-exact-infoset-reach-profile-v2';
const GROUP = /^pg_[0-9a-f]{64}$/;
const SECRET = /^ps_[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{64}$/;

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} fields do not match the frozen row contract`);
  }
}

function sortedUnique(raw, pattern, label, { min = 1 } = {}) {
  if (!Array.isArray(raw) || raw.length < min
    || raw.some((value) => typeof value !== 'string' || !pattern.test(value))
    || new Set(raw).size !== raw.length
    || raw.some((value, index) => index > 0 && value < raw[index - 1])) {
    throw new RangeError(`${label} must be a sorted unique opaque list`);
  }
  return Object.freeze([...raw]);
}

function distribution(raw, actionKeys, label) {
  exactKeys(raw, actionKeys, label);
  let total = 0;
  const values = Object.create(null);
  for (const action of actionKeys) {
    const probability = Number(raw[action]);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError(`${label}.${action} must be a probability`);
    }
    values[action] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 1e-9) throw new RangeError(`${label} must sum to one`);
  return Object.freeze(values);
}

/**
 * Strict offline join contract. It deliberately requires a complete frozen
 * QYZ base distribution; chosen-action counts cannot satisfy this schema.
 */
export function validateCompactResidualRowDataset(raw) {
  exactKeys(raw, [
    'schema', 'version', 'profileSchema', 'profileVersion',
    'sourceGroupSecretId', 'profileSources', 'rows',
  ], 'residual row dataset');
  if (raw.schema !== COMPACT_RESIDUAL_ROWS_SCHEMA
    || Number(raw.version) !== COMPACT_RESIDUAL_ROWS_VERSION
    || raw.profileSchema !== PROFILE_SCHEMA || Number(raw.profileVersion) !== 2) {
    throw new TypeError('unsupported residual row dataset');
  }
  const sourceGroupSecretId = String(raw.sourceGroupSecretId || '');
  if (!SECRET.test(sourceGroupSecretId)) throw new TypeError('invalid sourceGroupSecretId');
  if (!Array.isArray(raw.profileSources) || raw.profileSources.length < 1) {
    throw new TypeError('profileSources must be non-empty');
  }
  const allGroups = new Set();
  const profileHashes = new Set();
  const groupTables = new Map();
  const profileSources = raw.profileSources.map((source, index) => {
    const label = `profileSources[${index}]`;
    exactKeys(source, ['sha256', 'tableSize', 'sourceGroups'], label);
    const sha256 = String(source.sha256 || '').toLowerCase();
    const tableSize = Number(source.tableSize);
    if (!SHA.test(sha256) || profileHashes.has(sha256)
      || !Number.isInteger(tableSize) || tableSize < 2 || tableSize > 9) {
      throw new RangeError(`${label} is invalid or duplicated`);
    }
    profileHashes.add(sha256);
    const sourceGroups = sortedUnique(source.sourceGroups, GROUP, `${label}.sourceGroups`);
    for (const group of sourceGroups) {
      if (allGroups.has(group)) throw new RangeError('source groups must belong to one profile shard');
      allGroups.add(group);
      groupTables.set(group, tableSize);
    }
    return Object.freeze({ sha256, tableSize, sourceGroups });
  });
  if (!Array.isArray(raw.rows) || raw.rows.length < 1 || raw.rows.length > 1_000_000) {
    throw new RangeError('rows must contain 1..1000000 exact-root joins');
  }
  const exactRoots = new Set();
  const rowIdentities = new Set();
  let reachWeight = 0;
  let independentAdvantageRows = 0;
  let degenerateBaseRows = 0;
  const tables = new Set();
  const rows = raw.rows.map((row, index) => {
    const label = `rows[${index}]`;
    exactKeys(row, [
      'informationSetKey', 'baseStrategy', 'targetStrategy', 'sourceGroup',
      'targetLevel', 'reachWeight', 'independentActionAdvantages',
    ], label);
    const encoded = compactResidualFeatures(row.informationSetKey);
    if (!encoded) throw new RangeError(`${label}.informationSetKey is invalid`);
    exactRoots.add(row.informationSetKey);
    const actionKeys = blueprintActionKeysForMask(encoded.mask);
    const targetLevel = String(row.targetLevel || '');
    if (!['exact', 'history', 'position', 'strategic', 'population',
      'independent-advantage'].includes(targetLevel)) {
      throw new RangeError(`${label}.targetLevel is unsupported`);
    }
    const sourceGroup = String(row.sourceGroup || '');
    if (!GROUP.test(sourceGroup) || !allGroups.has(sourceGroup)) {
      throw new RangeError(`${label} references an unknown source group`);
    }
    if (groupTables.get(sourceGroup) < encoded.tableSize) {
      throw new RangeError(`${label} source table cannot be smaller than the key table size`);
    }
    const identity = `${sourceGroup}\u0000${row.informationSetKey}`;
    if (rowIdentities.has(identity)) throw new RangeError(`${label} duplicates a group/root row`);
    rowIdentities.add(identity);
    const baseStrategy = distribution(row.baseStrategy, actionKeys, `${label}.baseStrategy`);
    const targetStrategy = distribution(row.targetStrategy, actionKeys, `${label}.targetStrategy`);
    const weight = Number(row.reachWeight);
    if (!Number.isSafeInteger(weight) || weight < 1) {
      throw new RangeError(`${label}.reachWeight must be a positive safe integer`);
    }
    reachWeight += weight;
    tables.add(encoded.tableSize);
    if (actionKeys.filter((action) => baseStrategy[action] > 0).length < 2) degenerateBaseRows++;
    let independentActionAdvantages = null;
    if (row.independentActionAdvantages != null) {
      exactKeys(row.independentActionAdvantages, actionKeys, `${label}.independentActionAdvantages`);
      independentActionAdvantages = Object.freeze(Object.fromEntries(actionKeys.map((action) => {
        const value = Number(row.independentActionAdvantages[action]);
        if (!Number.isFinite(value) || value < -2 || value > 2) {
          throw new RangeError(`${label}.independentActionAdvantages must use -2..2 paired rank utility`);
        }
        return [action, value];
      })));
      independentAdvantageRows++;
    }
    return Object.freeze({
      informationSetKey: row.informationSetKey,
      tableSize: encoded.tableSize,
      legalMask: encoded.mask,
      actionKeys,
      baseStrategy,
      targetStrategy,
      sourceGroup,
      targetLevel,
      reachWeight: weight,
      independentActionAdvantages,
    });
  });
  return Object.freeze({
    schema: COMPACT_RESIDUAL_ROWS_SCHEMA,
    version: COMPACT_RESIDUAL_ROWS_VERSION,
    sourceGroupSecretId,
    profileSources: Object.freeze(profileSources),
    sourceGroups: Object.freeze([...allGroups].sort()),
    profileHashes: Object.freeze([...profileHashes].sort()),
    tableSizes: Object.freeze([...tables].sort((a, b) => a - b)),
    rows: Object.freeze(rows),
    summary: Object.freeze({
      rows: rows.length,
      exactRoots: exactRoots.size,
      reachWeight,
      sourceGroups: allGroups.size,
      independentAdvantageRows,
      degenerateBaseRows,
    }),
  });
}

/** Fail-closed readiness; no current V2 profile can fake the required base rows. */
export function compactResidualDatasetReadiness(dataset, {
  requiredTableSizes = [6, 9],
  minSourceGroups = 20,
} = {}) {
  const validated = validateCompactResidualRowDataset(dataset);
  const blockers = [];
  for (const table of requiredTableSizes) {
    if (!validated.tableSizes.includes(Number(table))) blockers.push(`table-${table}-missing`);
  }
  if (validated.summary.sourceGroups < Number(minSourceGroups)) {
    blockers.push('independent-source-groups-below-threshold');
  }
  // V2's explicit legal-action floor makes sparse base support representable.
  if (validated.summary.independentAdvantageRows !== validated.summary.rows) {
    blockers.push('independent-advantage-evidence-missing');
  }
  // Training/fitting and active deployment intentionally do not exist in V1.
  blockers.push('compact-residual-trainer-not-implemented');
  blockers.push('shadow-only-schema-cannot-deploy');
  return Object.freeze({
    trainableRows: validated.summary.rows - validated.summary.degenerateBaseRows,
    promotionEligible: false,
    blockers: Object.freeze([...new Set(blockers)].sort()),
    summary: validated.summary,
  });
}
