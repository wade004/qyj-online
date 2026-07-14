#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { mergeCompactResidualRowDatasets } from './blueprint/residual-data.mjs';

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0 || !args[outputIndex + 1]) {
  console.error('Usage: node training/merge-compact-residual.mjs --output merged.json shard6.json shard9.json');
  process.exit(1);
}
const output = args[outputIndex + 1];
const inputs = args.filter((_, index) => index !== outputIndex && index !== outputIndex + 1);
if (!inputs.length) throw new RangeError('at least one input shard is required');
const datasets = inputs.map((file) => JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
const merged = mergeCompactResidualRowDatasets(datasets);
const resolved = path.resolve(output);
fs.mkdirSync(path.dirname(resolved), { recursive: true });
fs.writeFileSync(resolved, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output: resolved, rows: merged.rows.length, shards: inputs.length }));
