import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { evaluateCases } from '../lib/evaluate.mjs';
import { readSampleFile } from './samples.mjs';

const marginOptions = [
  'conversion-min-lead', 'conversion-min-gain', 'prediction-min-lead', 'prediction-min-gain',
];

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean' },
      'operation-limit': { type: 'string' },
      model: { type: 'string' },
      ...Object.fromEntries(marginOptions.map(option => [option, { type: 'string' }])),
    },
    allowPositionals: true,
  });
  if (values.help) {
    console.log('Usage: node tools/evaluate.mjs <samples.jsonl> [--operation-limit 40] [--model <model.json>]');
    console.log('Model margins default to 0. Options:');
    console.log(marginOptions.map(option => `  --${option} <score>`).join('\n'));
    return;
  }
  if (positionals.length !== 1) throw new Error('provide one JSONL input path (see --help)');
  if (!values.model && marginOptions.some(option => values[option] !== undefined)) {
    throw new Error('model margins require --model');
  }
  const { rows } = await readSampleFile(positionals[0]);
  const model = values.model ? await readModel(values.model, values, rows[0].sample) : undefined;
  let currentLine;
  function* cases() {
    for (const { line, sample } of rows) {
      currentLine = line;
      yield sample;
    }
  }
  let result;
  try {
    result = evaluateCases(cases(), {
      operationLimit: values['operation-limit'] === undefined ? undefined : Number(values['operation-limit']),
      model,
    });
  } catch (error) {
    const prefix = currentLine === undefined ? '' : `line ${currentLine}: `;
    throw new Error(prefix + error.message);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function readModel(path, values, firstSample) {
  const { loadModel } = await import('../lib/model.mjs');
  const modelBytes = await readModelBytes(path);
  let data;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(modelBytes));
  } catch {
    throw new Error('model must be a valid UTF-8 JSON file');
  }
  const dictionarySha256 = firstSample?.provenance?.dictionarySha256;
  const thresholds = {};
  for (const mode of ['conversion', 'prediction']) {
    const minLead = Number(values[`${mode}-min-lead`] ?? 0);
    const minGain = Number(values[`${mode}-min-gain`] ?? 0);
    if (![minLead, minGain].every(margin => Number.isFinite(margin) && margin >= 0)) {
      throw new Error('model margins must be finite nonnegative numbers');
    }
    thresholds[mode] = { minLead, minGain };
  }
  return { dictionarySha256, thresholds, score: loadModel(data, { dictionarySha256 }) };
}

async function readModelBytes(path) {
  const file = await open(path);
  try {
    const limit = 2 * 1_024 ** 2;
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset <= limit) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) return buffer.subarray(0, offset);
      offset += bytesRead;
    }
    throw new Error('model file exceeds 2 MiB');
  } finally {
    await file.close();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
