#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { materializeResidualAdvantageRows } from './blueprint/residual-advantage.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
};
for (const flag of ['--guidance', '--base-dataset', '--output']) {
  if (!value(flag)) throw new RangeError(`${flag} is required`);
}
const artifact = materializeResidualAdvantageRows(
  JSON.parse(fs.readFileSync(path.resolve(value('--guidance')), 'utf8')),
  JSON.parse(fs.readFileSync(path.resolve(value('--base-dataset')), 'utf8')),
  { includeIdentityRows: args.includes('--include-identity-rows') },
);
const output = path.resolve(value('--output'));
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ output, rows: artifact.rows.length }));
