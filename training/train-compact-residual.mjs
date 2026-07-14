#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { trainCompactResidualPolicy } from './blueprint/residual-trainer.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback = null) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
};
const input = value('--dataset');
const output = value('--output');
const reportPath = value('--report');
if (!input || !output || !reportPath) {
  console.error('Usage: node training/train-compact-residual.mjs --dataset rows.json --output model.json --report report.json');
  process.exit(1);
}
const dataset = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'));
const advantageGuidancePath = value('--advantage-guidance');
const advantageGuidance = advantageGuidancePath
  ? JSON.parse(fs.readFileSync(path.resolve(advantageGuidancePath), 'utf8')) : null;
const { model, report } = trainCompactResidualPolicy(dataset, {
  basePolicyContract: value('--base-policy-contract', 'qyj-range-ev-v1'),
  baseStyleKey: value('--base-style', 'tag'),
  ensembleSize: Number(value('--ensemble', 5)),
  advantageGuidance,
});
for (const [file, artifact] of [[output, model], [reportPath, report]]) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}
console.log(JSON.stringify({ output: path.resolve(output), report: path.resolve(reportPath), metrics: report.metrics }));
