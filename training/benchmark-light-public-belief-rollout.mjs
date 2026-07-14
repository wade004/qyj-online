#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import {
  evaluatePublicBeliefRolloutActions,
  evaluateScreenedPublicBeliefRolloutActions,
} from './eval/public-belief-rollout.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const tableSize = Number(value('--table', 6));
const rootLimit = Number(value('--roots', 4));
const clusterCount = Number(value('--clusters', 4));
const profile = JSON.parse(fs.readFileSync(value(
  '--profile', `training/profiles/qyj-reach-v45b-train-${tableSize}.json`,
), 'utf8'));
const discovery = JSON.parse(fs.readFileSync(value(
  '--discovery', `training/artifacts/qyj-v62-rollout-guidance-${tableSize}-model.json`,
), 'utf8'));
const entries = new Map(profile.entries.map((entry) => [entry.exactKey, entry]));
const roots = Object.entries(discovery.records || {}).filter(([informationSetKey, record]) => (
  record.rollout?.accepted && entries.has(informationSetKey)
)).map(([informationSetKey, record]) => ({
  entry: entries.get(informationSetKey), record,
})).filter((row) => row.entry).slice(0, rootLimit);
const rows = [];
for (let index = 0; index < roots.length; index++) {
  const { entry, record } = roots[index];
  const { observerIdx, ...snapshot } = entry.trainingSnapshot;
  const target = { targetKey: entry.exactKey, actorIdx: observerIdx, snapshot };
  const common = {
    baseActionKey: record.baseActionKey,
    actionKeys: record.legalActionKeys.filter(
      (actionKey) => actionKey !== 'allin' || actionKey === record.baseActionKey,
    ),
    seedNamespace: `qyj-v65-fidelity-${tableSize}|root|${index}`,
    clusterCount,
    minAdvantage: Math.max(1, Number(snapshot.betting?.pot) * 0.005),
  };
  const fullStarted = performance.now();
  const full = evaluatePublicBeliefRolloutActions(target, common);
  const fullMs = performance.now() - fullStarted;
  const lightStarted = performance.now();
  const light = evaluatePublicBeliefRolloutActions(target, {
    ...common,
    continuationEquityScale: 0.08,
    continuationEquityFloor: 24,
  });
  const lightMs = performance.now() - lightStarted;
  const fastStarted = performance.now();
  const fast = evaluatePublicBeliefRolloutActions(target, {
    ...common,
    continuationMode: 'fast-public',
  });
  const fastMs = performance.now() - fastStarted;
  const screenedStarted = performance.now();
  const screened = evaluateScreenedPublicBeliefRolloutActions(target, {
    baseActionKey: common.baseActionKey,
    actionKeys: common.actionKeys,
    seedNamespace: `${common.seedNamespace}|screened`,
    screenClusterCount: clusterCount,
    confirmationClusterCount: clusterCount,
    minAdvantage: common.minAdvantage,
  });
  const screenedMs = performance.now() - screenedStarted;
  rows.push({
    rootSha256: full.provenance.rootSha256,
    full: { accepted: full.accepted, actionKey: full.actionKey, ms: fullMs },
    light: { accepted: light.accepted, actionKey: light.actionKey, ms: lightMs },
    fast: { accepted: fast.accepted, actionKey: fast.actionKey, ms: fastMs },
    screened: {
      accepted: screened.accepted, actionKey: screened.actionKey, ms: screenedMs,
      confirmationRan: screened.confirmation != null,
    },
    sameAcceptance: full.accepted === light.accepted,
    sameAction: full.actionKey === light.actionKey,
    fastSameAcceptance: full.accepted === fast.accepted,
    fastSameAction: full.actionKey === fast.actionKey,
    screenedSameAcceptance: full.accepted === screened.accepted,
    screenedSameAction: full.actionKey === screened.actionKey,
    speedup: fullMs / Math.max(0.001, lightMs),
    fastSpeedup: fullMs / Math.max(0.001, fastMs),
    screenedSpeedup: fullMs / Math.max(0.001, screenedMs),
  });
}
const mean = (values) => values.reduce((sum, item) => sum + item, 0) / Math.max(1, values.length);
console.log(JSON.stringify({
  schema: 'qyj-light-public-belief-rollout-benchmark-v1',
  tableSize,
  roots: rows.length,
  clusterCount,
  sameAcceptance: rows.filter((row) => row.sameAcceptance).length,
  sameAction: rows.filter((row) => row.sameAction).length,
  fastSameAcceptance: rows.filter((row) => row.fastSameAcceptance).length,
  fastSameAction: rows.filter((row) => row.fastSameAction).length,
  screenedSameAcceptance: rows.filter((row) => row.screenedSameAcceptance).length,
  screenedSameAction: rows.filter((row) => row.screenedSameAction).length,
  meanFullMs: mean(rows.map((row) => row.full.ms)),
  meanLightMs: mean(rows.map((row) => row.light.ms)),
  meanSpeedup: mean(rows.map((row) => row.speedup)),
  meanFastMs: mean(rows.map((row) => row.fast.ms)),
  meanFastSpeedup: mean(rows.map((row) => row.fastSpeedup)),
  meanScreenedMs: mean(rows.map((row) => row.screened.ms)),
  meanScreenedSpeedup: mean(rows.map((row) => row.screenedSpeedup)),
  rows,
}, null, 2));
