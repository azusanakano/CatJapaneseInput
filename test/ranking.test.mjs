import assert from 'node:assert/strict';
import test from 'node:test';
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
