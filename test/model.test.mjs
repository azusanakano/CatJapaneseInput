import assert from 'node:assert/strict';
import test from 'node:test';

import { extractContext } from '../lib/context.mjs';
import { evaluateCases } from '../lib/evaluate.mjs';
import { loadModel, trainModel } from '../lib/model.mjs';

const dictionarySha256 = 'a'.repeat(64);
const candidates = [
  { id: 0, reading: 'かいとう', value: '回答', consumption: 'full' },
  { id: 1, reading: 'かいとう', value: '解凍', consumption: 'full' },
];

function example(context, intended, mode = 'conversion') {
  return {
    mode,
    context,
    targets: [[intended]],
    segments: [{ reading: 'かいとう', candidates }],
  };
}

function scores(scorer, sample) {
  const segment = sample.segments[0];
  const context = extractContext(sample.context);
  return segment.candidates.map((candidate, candidateIndex) =>
    scorer({ sample, segment, segmentIndex: 0, candidate, candidateIndex }, context));
}

test('an INT8 round trip retains the opposite rankings learned from two lines back', () => {
  const surveys = example('アンケートを書いた。\n明日は作業する。\n', '回答');
  const food = example('冷凍肉を揃えた。\n明日は作業する。\n', '解凍');
  const trained = trainModel([surveys, food], { dictionarySha256, epochs: 800, seed: 9 });
  const saved = JSON.stringify(trained);
  assert(saved.length < 2 * 1024 * 1024);
  const score = loadModel(JSON.parse(saved), { dictionarySha256 });
  const [surveyAnswer, surveyThaw] = scores(score, surveys);
  const [foodAnswer, foodThaw] = scores(score, food);
  assert(surveyAnswer > surveyThaw);
  assert(foodThaw > foodAnswer);
  assert(trained.training.lastEpochLoss < trained.training.firstEpochLoss);
});

test('separate output heads can learn different positives with the same input', () => {
  const conversion = example(null, '回答');
  const prediction = { ...example(null, '解凍', 'prediction'), targets: undefined, acceptedTexts: ['解凍'] };
  const score = loadModel(trainModel([conversion, prediction], { dictionarySha256, epochs: 20, seed: 4 }),
    { dictionarySha256 });
  const [convertedAnswer, convertedThaw] = scores(score, conversion);
  const [predictedAnswer, predictedThaw] = scores(score, prediction);
  assert(convertedAnswer > convertedThaw);
  assert(predictedThaw > predictedAnswer);
});

test('excludes unaligned and out-of-group positives from training', () => {
  const unaligned = example('', '未知');
  const partial = {
    ...example('', '解凍', 'prediction'),
    segments: [{ reading: 'かいとう', candidates: [candidates[0], { ...candidates[1], consumption: 'partial' }] }],
  };
  assert.throws(() => trainModel([unaligned, partial], { dictionarySha256 }), /positive/i);
});

test('treats all accepted candidates as positive probability mass', () => {
  const sample = { ...example(null, '回答'), targets: [['回答'], ['解凍']] };
  const trained = trainModel([sample], { dictionarySha256, epochs: 1 });
  assert.equal(trained.training.firstEpochLoss, 0);
});

for (const mode of ['conversion', 'prediction']) {
  for (const field of ['targets', 'acceptedTexts']) {
    test(`${mode} training and evaluation reject an explicit null ${field}`, () => {
      const sample = { ...example(null, '解凍', mode), acceptedTexts: ['解凍'], [field]: null };
      assert.throws(() => evaluateCases([sample]), TypeError);
      assert.throws(() => trainModel([sample, example(null, '回答', mode)],
        { dictionarySha256, epochs: 1 }), TypeError);
    });
  }
}

test('omitted label arrays retain their training and evaluation behavior', () => {
  const conversion = example(null, '解凍');
  const prediction = { ...example(null, '解凍', 'prediction'), acceptedTexts: ['解凍'] };
  delete prediction.targets;
  for (const sample of [conversion, prediction]) {
    const trained = trainModel([sample], { dictionarySha256, epochs: 1 });
    assert.deepEqual(trained.trainedModes, [sample.mode]);
    assert.equal(evaluateCases([sample])[sample.mode].cases, 1);
  }

  const unlabeled = { ...conversion };
  delete unlabeled.targets;
  const trained = trainModel([unlabeled, conversion], { dictionarySha256, epochs: 1 });
  assert.equal(trained.training.groups, 1);
  assert.throws(() => evaluateCases([unlabeled]), /accepted text or aligned target/);
});

test('model load rejects dictionary mismatches and corrupt quantized payloads', () => {
  const sample = example(null, '回答');
  const options = { dictionarySha256, epochs: 1, seed: 42 };
  const trained = trainModel([sample], options);
  assert.deepEqual(trained, trainModel([sample], options));
  assert.throws(() => loadModel(trained, { dictionarySha256: 'b'.repeat(64) }), /dictionary/i);
  const quantized = trained.parameters.embedding;
  assert.throws(() => loadModel({
    ...trained, parameters: { ...trained.parameters, embedding: { ...quantized, values: 'AA==' } },
  }, { dictionarySha256 }), /embedding/i);
});

test('untrained modes leave candidates tied at the baseline', () => {
  const conversion = example(null, '回答');
  const prediction = example(null, '解凍', 'prediction');
  const score = loadModel(trainModel([conversion], { dictionarySha256 }), { dictionarySha256 });
  assert.deepEqual(scores(score, prediction), [0, 0]);
});
