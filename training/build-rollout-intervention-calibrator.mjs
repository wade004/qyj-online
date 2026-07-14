#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  buildRolloutInterventionCalibrator,
  evaluateRolloutInterventionTest,
} from './eval/rollout-intervention-calibrator.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const paths = (flag) => String(value(flag, '')).split(',')
  .map((item) => item.trim()).filter(Boolean).map((item) => path.resolve(item));
const read = (items) => items.map((item) => JSON.parse(fs.readFileSync(item, 'utf8')));
const trainingPaths = paths('--training');
const calibrationPaths = paths('--calibration');
const testPaths = paths('--test');
if (!trainingPaths.length || !calibrationPaths.length) {
  throw new RangeError('--training and --calibration require dataset paths');
}
const calibrator = buildRolloutInterventionCalibrator(
  read(trainingPaths),
  read(calibrationPaths),
  {
    minTrainingClusters: Number(value('--min-training-clusters', 4)),
    minCalibrationClusters: Number(value('--min-calibration-clusters', 2)),
  },
);
const output = path.resolve(value(
  '--output', 'training/checkpoints/qyj-v73-rollout-intervention-calibrator.json',
));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(calibrator, null, 2)}\n`, 'utf8');
let report = null;
if (testPaths.length) {
  report = evaluateRolloutInterventionTest(calibrator, read(testPaths));
  const reportOutput = path.resolve(value(
    '--report', 'training/artifacts/qyj-v73-rollout-intervention-test.json',
  ));
  fs.mkdirSync(path.dirname(reportOutput), { recursive: true });
  fs.writeFileSync(reportOutput, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({
  output,
  rules: calibrator.rules.length,
  testPassed: report?.passed ?? null,
}));
