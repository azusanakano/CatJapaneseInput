import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { trainModel } from '../lib/model.mjs';
import { validateSample } from '../lib/ranking.mjs';
import { readSampleFile } from './samples.mjs';

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean' },
      epochs: { type: 'string' },
      seed: { type: 'string' },
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log('Usage: node tools/train.mjs <training.jsonl> <model.json> [--epochs <n>] [--seed <n>]');
    return;
  }
  if (positionals.length !== 2) throw new Error('provide input and new output paths (see --help)');
  const { bytes, rows } = await readSampleFile(positionals[0]);
  const dictionarySha256 = rows[0].sample?.provenance?.dictionarySha256;
  if (typeof dictionarySha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(dictionarySha256)) {
    throw new Error('training captures must contain a dictionary SHA-256 digest');
  }
  const samples = rows.map(({ line, sample }) => {
    try {
      validateSample(sample);
      if (sample.provenance?.dictionarySha256 !== dictionarySha256) throw new Error('dictionary hash differs');
    } catch (error) {
      throw new Error(`line ${line}: ${error.message}`);
    }
    return sample;
  });
  const model = trainModel(samples, {
    dictionarySha256,
    epochs: values.epochs === undefined ? undefined : Number(values.epochs),
    seed: values.seed === undefined ? undefined : Number(values.seed),
  });
  const trainingSourceSha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(positionals[1], JSON.stringify({ ...model, trainingSourceSha256 }) + '\n', { flag: 'wx' });
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
