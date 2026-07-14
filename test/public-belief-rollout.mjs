import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  evaluatePublicBeliefOptionPlans,
  evaluatePublicBeliefRolloutActions,
  evaluateScreenedPublicBeliefRolloutActions,
} from '../training/eval/public-belief-rollout.mjs';
import {
  evaluateConfirmationConfidenceCap,
  evaluateConfirmationConfidenceFloor,
} from '../training/eval/strategies.mjs';
import { compileTournamentValueModel } from '../training/tournament-value/model.js';

const profile = JSON.parse(fs.readFileSync(
  'training/profiles/qyj-reach-v45b-train-6.json', 'utf8',
));
const entry = profile.entries.find((candidate) => (
  candidate.trainingSnapshot?.street !== 'idle'
  && candidate.trainingSnapshot?.legalActions
));
assert(entry);
const { observerIdx, ...snapshot } = entry.trainingSnapshot;
const target = { targetKey: entry.exactKey, actorIdx: observerIdx, snapshot };
const legal = [
  ...(snapshot.legalActions.canCheck ? ['check'] : ['fold', 'call']),
  ...snapshot.legalActions.tiers.map((tier) => `raise:${tier.key}`),
  ...(snapshot.legalActions.canAllIn ? ['allin'] : []),
];
const baseActionKey = legal[0];
const options = {
  baseActionKey,
  actionKeys: legal,
  seedNamespace: 'public-belief-rollout-self-test',
  clusterCount: 2,
  minAdvantage: 1,
};
const first = evaluatePublicBeliefRolloutActions(target, options);
const second = evaluatePublicBeliefRolloutActions(target, options);
assert.deepEqual(second, first, 'public root and namespace must reproduce every rollout');
assert.equal(first.schema, 'qyj-public-belief-engine-rollout-v1');
assert.equal(first.utilitySamples, legal.length * 2);
assert(first.continuationDecisions >= first.utilitySamples);
assert.equal(first.provenance.hiddenStateSource, 'allow-listed-public-belief-sampler-only');
assert(legal.includes(first.actionKey));

const screenedOptions = {
  baseActionKey,
  actionKeys: legal.filter((actionKey) => actionKey !== 'allin' || actionKey === baseActionKey),
  seedNamespace: 'screened-public-belief-rollout-self-test',
  screenClusterCount: 2,
  confirmationClusterCount: 2,
  minAdvantage: 1,
};
const screened = evaluateScreenedPublicBeliefRolloutActions(target, screenedOptions);
const screenedAgain = evaluateScreenedPublicBeliefRolloutActions(target, screenedOptions);
assert.deepEqual(screenedAgain, screened, 'screen and confirmation namespaces must reproduce');
assert.equal(screened.schema, 'qyj-screened-public-belief-engine-rollout-v1');
assert.equal(screened.screen.provenance.hiddenStateSource,
  'allow-listed-public-belief-sampler-only');
assert.equal(screened.screen.provenance.continuationMode, 'fast-public');
if (screened.confirmation) {
  assert.equal(screened.confirmation.provenance.hiddenStateSource,
    'allow-listed-public-belief-sampler-only');
  assert.equal(screened.confirmation.provenance.continuationEquityFloor, 24);
}

const tournamentValueModel = compileTournamentValueModel(JSON.parse(fs.readFileSync(
  'training/checkpoints/qyj-tv-v4-formal.json', 'utf8',
)));
const dual = evaluatePublicBeliefRolloutActions(target, {
  ...options,
  actionKeys: legal.slice(0, 2),
  baseActionKey: legal[0],
  seedNamespace: 'public-belief-dual-tournament-self-test',
  continuationEquityScale: 0.08,
  continuationEquityFloor: 24,
  utilityMode: 'dual-tournament',
  tournamentValueModel,
  tournamentRiskWeight: 0.25,
  minTournamentAdvantage: 0,
});
assert.equal(dual.utilityMode, 'dual-tournament');
assert.equal(dual.provenance.utilityObjective,
  'paired-hp-and-risk-adjusted-tournament-value-lcb');
assert.equal(dual.provenance.tournamentGateStatistic, 'lowerBound');
assert(dual.candidates.every((candidate) => (
  Number.isFinite(candidate.hp.mean)
  && Number.isFinite(candidate.tournament.mean)
  && Number.isFinite(candidate.tournament.lowerBound)
)));

const dualScreened = evaluateScreenedPublicBeliefRolloutActions(target, {
  ...screenedOptions,
  actionKeys: legal.slice(0, 2),
  baseActionKey: legal[0],
  seedNamespace: 'screened-public-belief-dual-tournament-self-test',
  screenUtilityMode: 'dual-tournament',
  confirmationUtilityMode: 'dual-tournament',
  tournamentValueModel,
  tournamentRiskWeight: 0.25,
  minTournamentAdvantage: 0,
});
assert.equal(dualScreened.screenUtilityMode, 'dual-tournament');
assert.equal(dualScreened.screen.utilityMode, 'dual-tournament');
assert.equal(dualScreened.screen.provenance.utilityObjective,
  'paired-hp-and-risk-adjusted-tournament-value-lcb');
if (dualScreened.confirmation) {
  assert.equal(dualScreened.confirmation.utilityMode, 'dual-tournament');
}

const meanScreened = evaluateScreenedPublicBeliefRolloutActions(target, {
  ...screenedOptions,
  actionKeys: legal.slice(0, 2),
  baseActionKey: legal[0],
  seedNamespace: 'screened-public-belief-mean-tournament-self-test',
  screenUtilityMode: 'dual-tournament',
  confirmationUtilityMode: 'dual-tournament',
  screenTournamentGateStatistic: 'mean',
  confirmationTournamentGateStatistic: 'lowerBound',
  screenCandidateCount: 2,
  tournamentValueModel,
  tournamentRiskWeight: 0.25,
  minTournamentAdvantage: 0,
});
assert.equal(meanScreened.screen.provenance.tournamentGateStatistic, 'mean');
assert.equal(meanScreened.screen.provenance.utilityObjective,
  'paired-hp-lcb-and-risk-adjusted-tournament-value-mean');
assert(meanScreened.screenCandidateActionKeys.length <= 2);
if (meanScreened.accepted) {
  assert.equal(meanScreened.actionKey, meanScreened.confirmation.actionKey);
  assert(meanScreened.screenCandidateActionKeys.includes(meanScreened.actionKey));
}

const survivalAware = evaluatePublicBeliefRolloutActions(target, {
  ...options,
  actionKeys: legal.slice(0, 2),
  baseActionKey: legal[0],
  seedNamespace: 'public-belief-hp-survival-self-test',
  continuationEquityScale: 0.08,
  continuationEquityFloor: 24,
  utilityMode: 'hp-survival',
  minSurvivalAdvantage: 0,
  survivalGateStatistic: 'mean',
});
assert.equal(survivalAware.utilityMode, 'hp-survival');
assert.equal(survivalAware.provenance.utilityObjective,
  'paired-hp-lcb-and-hand-survival-mean');
assert.equal(survivalAware.provenance.survivalGateStatistic, 'mean');
assert(survivalAware.candidates.every((candidate) => (
  Number.isFinite(candidate.hp.lowerBound)
  && Number.isFinite(candidate.survival.mean)
  && Number.isFinite(candidate.survival.lowerBound)
)));

const tripleAware = evaluatePublicBeliefRolloutActions(target, {
  ...options,
  actionKeys: legal.slice(0, 2),
  baseActionKey: legal[0],
  seedNamespace: 'public-belief-triple-tournament-survival-self-test',
  continuationEquityScale: 0.08,
  continuationEquityFloor: 24,
  utilityMode: 'triple-tournament-survival',
  tournamentValueModel,
  minTournamentAdvantage: 0,
  minSurvivalAdvantage: 0,
});
assert.equal(tripleAware.utilityMode, 'triple-tournament-survival');
assert.equal(tripleAware.provenance.utilityObjective,
  'paired-hp-tournament-and-hand-survival-lowerBound');
assert(tripleAware.candidates.every((candidate) => (
  Number.isFinite(candidate.hp.lowerBound)
  && Number.isFinite(candidate.tournament.lowerBound)
  && Number.isFinite(candidate.survival.lowerBound)
)));

const optionPlans = [
  { id: `${legal[0]}|qyz`, firstActionKey: legal[0], continuationMode: null },
  { id: `${legal[0]}|control`, firstActionKey: legal[0], continuationMode: 'control' },
  { id: `${legal[0]}|pressure`, firstActionKey: legal[0], continuationMode: 'pressure' },
  { id: `${legal[0]}|thin-value`, firstActionKey: legal[0], continuationMode: 'thin-value' },
  { id: `${legal[0]}|polarized`, firstActionKey: legal[0], continuationMode: 'polarized' },
];
const optionPlanOptions = {
  basePlanId: optionPlans[0].id,
  plans: optionPlans,
  seedNamespace: 'public-belief-two-step-option-self-test',
  clusterCount: 3,
  continuationMode: 'fast-public',
  continuationEquityScale: 0.08,
  continuationEquityFloor: 24,
  minAdvantage: 1,
  tournamentValueModel,
  tournamentGateStatistic: 'mean',
  hpGateStatistic: 'mean',
  survivalGateStatistic: 'lowerBound',
  minContinuationReachRate: 0.5,
};
const optionPlan = evaluatePublicBeliefOptionPlans(target, optionPlanOptions);
const optionPlanAgain = evaluatePublicBeliefOptionPlans(target, optionPlanOptions);
assert.deepEqual(optionPlanAgain, optionPlan,
  'two-step option evaluation must reproduce root and continuation samples');
assert.equal(optionPlan.schema, 'qyj-public-belief-two-step-option-v1');
assert.equal(optionPlan.minContinuationReachRate, 0.5);
assert.equal(optionPlan.hpGateStatistic, 'mean');
assert(optionPlan.candidates.every((candidate) => (
  Number.isFinite(candidate.hp.lowerBound)
  && Number.isFinite(candidate.tournament.lowerBound)
  && Number.isFinite(candidate.survival.lowerBound)
  && candidate.continuationReachRate >= 0
  && candidate.continuationReachRate <= 1
  && candidate.validClusterCount === optionPlan.clusterCount
  && candidate.validClusterRate === 1
)));
assert(optionPlan.eligibleCandidates.every(
  (candidate) => candidate.continuationReachRate >= optionPlan.minContinuationReachRate,
));

const capped = evaluateConfirmationConfidenceCap({
  accepted: true,
  confirmation: { selected: { lowerBound: 126 } },
}, { pot: 1000, maxNormalizedConfirmationAdvantage: 0.125 });
assert.equal(capped.rejected, true);
assert.equal(capped.normalizedConfirmationAdvantage, 0.126);
assert.equal(evaluateConfirmationConfidenceCap({
  accepted: true,
  confirmation: { selected: { lowerBound: 125 } },
}, { pot: 1000, maxNormalizedConfirmationAdvantage: 0.125 }).rejected, false);
assert.equal(evaluateConfirmationConfidenceCap({
  accepted: true,
  confirmation: { selected: { lowerBound: 1000 } },
}, { pot: 1, maxNormalizedConfirmationAdvantage: Infinity }).rejected, false);
assert.equal(evaluateConfirmationConfidenceFloor({
  accepted: true,
  confirmation: { selected: { lowerBound: 7.49 } },
}, { pot: 1000, minNormalizedConfirmationAdvantage: 0.0075 }).rejected, true);
assert.equal(evaluateConfirmationConfidenceFloor({
  accepted: true,
  confirmation: { selected: { lowerBound: 7.5 } },
}, { pot: 1000, minNormalizedConfirmationAdvantage: 0.0075 }).rejected, false);

console.log('public-belief Engine rollout tests passed');
