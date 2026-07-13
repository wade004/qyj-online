import assert from 'node:assert/strict';
import fs from 'node:fs';

import { compactResidualFeatures } from '../js/game/blueprint-residual-policy.js';
import {
  buildRealEngineTransferSelector,
  evaluateRealEngineTransferSelector,
} from '../training/eval/real-engine-transfer-selector.mjs';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const informationSetKey = profile.entries.find((entry) => entry.exactKey)?.exactKey;
const encoded = compactResidualFeatures(informationSetKey);
assert(encoded);
const tournamentValueSource = { schema: 'fixture', version: 1, sha256: 'a'.repeat(64) };
const records = {};
for (let root = 0; root < 4; root++) {
  records[String(root).padStart(64, '0')] = {
    mask: encoded.mask,
    features: { s: encoded.features.s, p: encoded.features.p, ip: encoded.features.ip },
    baseActionKey: 'check',
    actionKey: 'raise:strike',
    samples: 12,
    clusters: Array.from({ length: 6 }, (_, cluster) => ({
      clusterId: `cluster-${cluster}`,
      rankAdvantage: 0.15 + root * 0.001,
      hpAdvantage: 20 + root,
      samples: 2,
    })),
  };
}
const calibration = {
  schema: 'qyj-online-resolver-transfer-calibration-v1',
  version: 1,
  mode: 'offline-evaluation-only',
  tableSize: 6,
  resolverStrategyKey: 'resolver-fixture',
  featureOrder: ['s', 'p', 'ip'],
  tournamentValueSources: [tournamentValueSource],
  records,
};
const selector = buildRealEngineTransferSelector(calibration, {
  resolverStrategyKey: 'resolver-fixture',
  minNeighbors: 4,
  minIndependentClusters: 6,
  minSamples: 24,
});
const accepted = evaluateRealEngineTransferSelector(selector, {
  informationSetKey,
  tableSize: 6,
  baseActionKey: 'check',
  actionKey: 'raise:strike',
  tournamentValueSource,
});
assert.equal(accepted.eligible, true);
assert(accepted.rankLowerBound > 0 && accepted.hpLowerBound > 0);
assert.equal(evaluateRealEngineTransferSelector(selector, {
  informationSetKey,
  tableSize: 9,
  baseActionKey: 'check',
  actionKey: 'raise:strike',
  tournamentValueSource,
}).eligible, false);
assert.equal(evaluateRealEngineTransferSelector(selector, {
  informationSetKey,
  tableSize: 6,
  baseActionKey: 'check',
  actionKey: 'raise:strike',
  tournamentValueSource: { ...tournamentValueSource, sha256: 'b'.repeat(64) },
}).reason, 'transfer-tournament-source-mismatch');

console.log('real-engine transfer selector tests passed');
