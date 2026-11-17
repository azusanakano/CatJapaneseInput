import assert from 'node:assert/strict';
import test from 'node:test';
import { extractContext } from '../lib/context.mjs';
import { evaluateCases } from '../lib/evaluate.mjs';
import { loadModel, trainModel } from '../lib/model.mjs';
import {
  eligiblePromotions,
  promote,
  rankCase,
  scoringGroups,
  validateSample,
} from '../lib/ranking.mjs';

const candidate = (id, value, attributes = {}) => ({
  id, value, reading: 'かいとう', ...attributes,
});
const segment = (candidates, attributes = {}) => ({
  reading: 'かいとう', candidates, ...attributes,
});
const conversion = (...segments) => ({ mode: 'conversion', segments });
const prediction = (candidates, reading = 'かいと') => ({
  mode: 'prediction', segments: [segment(candidates, { reading })],
});
const ids = (segments) => segments.map(({ candidates }) => candidates.map(({ id }) => id));

test('promotes in the leftmost qualifying segment and preserves fixed and protected positions', () => {
  const sample = conversion(
    segment([candidate(1, '会'), candidate(2, '回')], { fixed: true }),
    segment([
      candidate(-1, 'カイトウ', { kind: 'protected' }),
      candidate(7, '回答'),
      candidate(-2, 'かいとう', { kind: 'protected' }),
      candidate(31, '解凍'),
      candidate(10, '解答'),
    ]),
    segment([candidate(100, '怪盗'), candidate(205, '海棠')]),
  );
  const score = ({ candidate }) => candidate.id;
  const result = rankCase(sample, { score });
  assert.deepEqual(result.promotion, { segmentIndex: 1, candidateIndex: 3 });
  assert.deepEqual(ids(result.segments), [[1, 2], [-1, 31, -2, 7, 10], [100, 205]]);
  assert.deepEqual(ids(sample.segments), [[1, 2], [-1, 7, -2, 31, 10], [100, 205]]);
  assert.equal(result.segments[1].candidates[1], sample.segments[1].candidates[3]);
  assert.deepEqual(eligiblePromotions(sample), [
    { segmentIndex: 1, candidateIndex: 3 },
    { segmentIndex: 1, candidateIndex: 4 },
    { segmentIndex: 2, candidateIndex: 1 },
  ]);
  assert.deepEqual(ids(promote(sample, { segmentIndex: 2, candidateIndex: 1 })), [
    [1, 2], [-1, 7, -2, 31, 10], [205, 100],
  ]);
  assert.throws(() => promote(sample, { segmentIndex: 1, candidateIndex: 2 }), RangeError);
});

test('prediction scores only eligible candidates in the original eight normal positions', () => {
  const sample = prediction([
    candidate(-1, 'カイト', { kind: 'protected', consumption: 'full' }),
    candidate(1, '回答', { reading: 'カイトウ', consumption: 'full' }),
    candidate(2, '回', { reading: 'かい', consumption: 'partial' }),
    candidate(3, '解答'),
    candidate(4, '快投', { reading: 'かいと', consumption: 'full' }),
    candidate(5, '買う', { reading: 'かう', consumption: 'full' }),
    candidate(6, 'あ'.repeat(127) + '\u0344', { consumption: 'full' }),
    candidate(7, 'か\u3099'.repeat(65), { consumption: 'full' }),
    candidate(8, '解凍', { consumption: 'full' }),
    candidate(9, '怪盗', { consumption: 'full' }),
  ]);
  assert.deepEqual(scoringGroups(sample), [{ segmentIndex: 0, candidateIndices: [1, 4, 8] }]);
  const result = rankCase(sample, { score: ({ candidate }) => candidate.id });
  assert.deepEqual(ids(result.segments), [[-1, 8, 2, 3, 1, 5, 6, 7, 4, 9]]);
});

test('preserves baseline if the first normal prediction cannot be scored', () => {
  const sample = prediction([
    candidate(1, '回', { reading: 'かい', consumption: 'partial' }),
    candidate(2, '回答', { consumption: 'full' }),
    candidate(3, '解凍', { consumption: 'full' }),
  ]);
  assert.deepEqual(eligiblePromotions(sample), []);
  assert.deepEqual(rankCase(sample, { score: ({ candidate }) => candidate.id }), {
    segments: sample.segments,
    promotion: null,
  });
});

test('conversion counts the first four unfixed segments with multiple normal candidates', () => {
  const pair = () => segment([candidate(1, '回答'), candidate(2, '解凍')]);
  const sample = conversion(
    { ...pair(), fixed: true },
    segment([candidate(1, '回答'), candidate(-1, 'カイトウ', { kind: 'protected' })]),
    { ...pair(), reading: 'あ'.repeat(129) },
    pair(), pair(), pair(), pair(),
  );
  assert.deepEqual(eligiblePromotions(sample), [
    { segmentIndex: 3, candidateIndex: 1 },
    { segmentIndex: 4, candidateIndex: 1 },
    { segmentIndex: 5, candidateIndex: 1 },
  ]);
});

test('requires strict lead and gain margins and preserves baseline for nonfinite scores', () => {
  const sample = conversion(segment([
    candidate(1, '回答'), candidate(2, '解凍'), candidate(3, '解答'),
  ]));
  for (const [values, minLead, minGain, winningIndex] of [
    [[2, 8, 4], 3, 5, 1],
    [[2, 8, 4], 4, 5, null],
    [[2, 8, 4], 3, 6, null],
    [[2, 8, 8], 0, 0, null],
    [[2, 8, NaN], 0, 0, null],
    [[2, Infinity, 4], 0, 0, null],
  ]) {
    const result = rankCase(sample, {
      score: ({ candidateIndex }) => values[candidateIndex], minLead, minGain,
    });
    assert.equal(result.promotion?.candidateIndex ?? null, winningIndex);
  }
});

test('rejects duplicate candidate IDs within a segment', () => {
  const segmentWithDuplicate = segment([candidate(1, '回答'), candidate(1, '解凍')]);
  assert.throws(() => validateSample(conversion(segmentWithDuplicate)), TypeError);
});

test('rejects full consumption when a candidate has the partial-consumption attribute', () => {
  for (const mode of ['conversion', 'prediction']) {
    const sample = {
      mode, context: '解凍', targets: [['解凍']],
      segments: [segment([
        candidate(0, '回答', { consumption: 'full' }),
        candidate(1, '解凍', { consumption: 'full', attributes: ['PARTIALLY_KEY_CONSUMED'] }),
      ])],
    };
    const invalidConsumption = { name: 'TypeError', message: /consumption/i };
    assert.throws(() => validateSample(sample), invalidConsumption);
    assert.throws(() => rankCase(sample, { score: ({ candidate }) => candidate.id }), invalidConsumption);
    assert.throws(() => trainModel([sample], { dictionarySha256: 'a'.repeat(64), epochs: 1 }), invalidConsumption);
    assert.throws(() => evaluateCases([sample]), invalidConsumption);
  }
});

test('partial-consumption attributes preserve partial, unknown, and omitted consumption labels', () => {
  for (const consumption of ['partial', 'unknown', undefined]) {
    const sample = {
      ...prediction([
        candidate(0, '回答', { consumption: 'full' }),
        candidate(1, '解凍', {
          attributes: ['PARTIALLY_KEY_CONSUMED'],
          ...(consumption === undefined ? {} : { consumption }),
        }),
      ]),
      targets: [['解凍']], context: '解凍',
    };
    assert.doesNotThrow(() => validateSample(sample));
    assert.doesNotThrow(() => validateSample({ ...sample, mode: 'conversion' }));
    assert.equal(rankCase(sample, { score: ({ candidate }) => candidate.id }).promotion, null);
    const result = evaluateCases([sample]).prediction;
    assert.equal(result.displayedTargetReachable, 1);
    assert.equal(result.allCandidateReachable, 0);
    assert.equal(result.currentLine.promoted, 0);
    assert.throws(() => trainModel([sample], { dictionarySha256: 'a'.repeat(64), epochs: 1 }), /positive/i);
  }
});

test('protection attributes override omitted and explicitly normal kinds in both modes', () => {
  for (const attribute of [
    'USER_DICTIONARY', 'NO_MODIFICATION', 'COMMAND_CANDIDATE',
    'SPELLING_CORRECTION', 'TYPING_CORRECTION',
  ]) {
    for (const kind of [undefined, 'normal']) {
      for (const mode of ['conversion', 'prediction']) {
        const protectedCandidate = candidate(99, '保護', {
          ...(kind === undefined ? {} : { kind }), attributes: [attribute], consumption: 'full',
        });
        const sample = { mode, segments: [segment([
          candidate(1, '回答', { consumption: 'full' }), protectedCandidate,
          candidate(3, '解凍', { consumption: 'full' }),
        ])] };
        assert.deepEqual(scoringGroups(sample), [{ segmentIndex: 0, candidateIndices: [0, 2] }]);
        assert.deepEqual(eligiblePromotions(sample), [{ segmentIndex: 0, candidateIndex: 2 }]);
        assert.throws(() => promote(sample, { segmentIndex: 0, candidateIndex: 1 }), RangeError);
        const ranked = rankCase(sample, { score: ({ candidate }) => candidate.id });
        assert.deepEqual(ids(ranked.segments), [[3, 99, 1]]);
        assert.equal(ranked.segments[0].candidates[1], protectedCandidate);
      }
    }
  }
});

test('attribute-protected candidates do not consume the original eight normal slots', () => {
  const sample = conversion(segment([
    candidate(99, '保護', { attributes: ['USER_DICTIONARY'] }),
    ...Array.from({ length: 9 }, (_, index) => candidate(index, `回答${index}`)),
  ]));
  assert.deepEqual(scoringGroups(sample), [{ segmentIndex: 0, candidateIndices: [1, 2, 3, 4, 5, 6, 7, 8] }]);
  const ranked = rankCase(sample, { score: ({ candidate }) => candidate.id });
  assert.deepEqual(ids(ranked.segments), [[99, 7, 0, 1, 2, 3, 4, 5, 6, 8]]);
  assert.throws(() => promote(sample, { segmentIndex: 0, candidateIndex: 9 }), RangeError);
});

test('an attribute-protected positive is excluded from training groups', () => {
  const sample = {
    ...conversion(segment([
      candidate(0, '回答'), candidate(1, '解凍', { attributes: ['USER_DICTIONARY'] }), candidate(2, '解答'),
    ])),
    targets: [['解凍']],
  };
  assert.throws(() => trainModel([sample], { dictionarySha256: 'a'.repeat(64), epochs: 1 }), /positive/i);
});

test('attribute-protected gold remains selectable without being promoted by scoring or oracle', () => {
  const result = evaluateCases([{
    ...conversion(segment([
      candidate(0, '回答'), candidate(1, '解凍', { attributes: ['USER_DICTIONARY'] }), candidate(2, '解答'),
    ])),
    targets: [['解凍']], context: '解凍',
  }]).conversion;
  assert.equal(result.allCandidateReachable, 1);
  assert.equal(result.reachableScoringGroups, 0);
  assert.equal(result.currentLine.promoted, 0);
  assert.equal(result.currentLine.totalOperations, 2);
  assert.equal(result.oracle.firstCorrect, 0);
  assert.equal(result.oracle.totalOperations, 2);
});

test('model cost features ignore protected candidates even without an explicit protected kind', () => {
  const dictionarySha256 = 'a'.repeat(64);
  const sample = {
    ...conversion(segment([
      candidate(99, '保護', { kind: 'protected', attributes: ['USER_DICTIONARY'], cost: -9000 }),
      candidate(0, '回答', { cost: 1000 }), candidate(1, '解凍', { cost: 1024 }),
    ])),
    targets: [['解凍']],
  };
  const score = loadModel(trainModel([sample], { dictionarySha256, epochs: 1 }), { dictionarySha256 });
  const lines = extractContext(null);
  function scores(input) {
    const segment = input.segments[0];
    return [1, 2].map(candidateIndex => score({
      sample: input, segment, segmentIndex: 0, candidate: segment.candidates[candidateIndex], candidateIndex,
    }, lines));
  }
  const expected = scores(sample);
  for (const kind of [undefined, 'normal']) {
    const imported = structuredClone(sample);
    if (kind === undefined) delete imported.segments[0].candidates[0].kind;
    else imported.segments[0].candidates[0].kind = kind;
    assert.deepEqual(scores(imported), expected);
  }
});
