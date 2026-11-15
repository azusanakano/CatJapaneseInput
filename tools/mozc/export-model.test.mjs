import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import { extractContext } from '../../lib/context.mjs';
import { loadModel, trainModel } from '../../lib/model.mjs';
import { exportNativeModel } from './export-model.mjs';

const dictionarySha256 = 'a'.repeat(64);
const candidates = [
  { id: 0, reading: 'カイﾄｳ', value: '回答', cost: 1_200, consumption: 'full' },
  { id: 1, reading: 'かいとう', value: '解凍', cost: 1_250, consumption: 'full' },
];
const samples = ['conversion', 'prediction'].flatMap(mode => [
  { mode, context: 'アンケートへの回答を集めます。\n作業は明日進めます。\n', targets: [['回答']] },
  { mode, context: '肉を解凍します。\n作業は明日進めます。\n', targets: [['解凍']] },
]).map(sample => ({ ...sample, segments: [{ reading: 'かいとう', candidates }] }));
const data = trainModel(samples, { dictionarySha256, epochs: 300, seed: 9 });

test('the native export stores both trained heads and exact signed INT8 bytes', () => {
  const binary = exportNativeModel(data);
  assert.equal(binary.length, 1_072_752);
  assert.equal(binary.toString('ascii', 0, 8), 'CATJINT8');
  assert.equal(binary.readUInt32LE(8), 1);
  assert.equal(binary.readUInt32LE(12), 0x00110000);
  assert.equal(binary.toString('ascii', 16, 80), dictionarySha256);
  assert.equal(binary[80], 3);
  assert.equal(binary.readDoubleLE(88), data.parameters.embedding.scale);
  assert.deepEqual(binary.subarray(144, 144 + 32_768 * 32), Buffer.from(data.parameters.embedding.values, 'base64'));
});

test('the native export rejects a malformed quantized parameter', () => {
  const malformed = structuredClone(data);
  malformed.parameters.firstBias.scale = 0;
  assert.throws(() => exportNativeModel(malformed), /firstBias/);
});

const nativeProbe = process.env.CATJ_NATIVE_MODEL_TEST;
test('the native model validates the blob and matches JS INT8 scores for both contexts and heads', {
  skip: !nativeProbe && 'set CATJ_NATIVE_MODEL_TEST to the compiled native model test',
}, async t => {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(join(parent, 'catj-int8-test-'));
  assert.equal(dirname(resolve(dir)), parent);
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 2 }));
  const binary = join(dir, 'context.bin');
  await writeFile(binary, exportNativeModel(data), { flag: 'wx' });
  const score = loadModel(data, { dictionarySha256 });
  const expected = samples.flatMap((sample) => {
    const segment = sample.segments[0];
    const lines = extractContext(sample.context);
    const values = candidates.map((candidate, candidateIndex) =>
      score({ sample, segment, segmentIndex: 0, candidate, candidateIndex }, lines));
    assert(values[sample.targets[0][0] === '回答' ? 0 : 1] > values[sample.targets[0][0] === '回答' ? 1 : 0]);
    return values;
  });
  const actual = execFileSync(nativeProbe, [binary], { encoding: 'utf8', windowsHide: true }).trim().split(/\s+/).map(Number);
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => assert(Math.abs(value - expected[i]) <= 1e-10, `${value} != ${expected[i]}`));
});
