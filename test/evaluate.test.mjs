import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCases } from '../lib/evaluate.mjs';

function segment(reading, ...values) {
  return {
    reading,
    candidates: values.map((value, id) => ({ id, value, reading, consumption: 'full' })),
  };
}

test('T17 counts one fewer selection key when the target moves to the top', () => {
  const result = evaluateCases([{
    mode: 'conversion',
    segments: [segment('はし', '橋', '箸')],
    targets: [['箸']],
    context: '箸を用意した。',
  }]);
  assert.equal(result.conversion.baseline.totalOperations, 2);
  assert.equal(result.conversion.currentLine.totalOperations, 1);
  assert.equal(result.conversion.threeLines.firstCorrect, 1);
  assert.equal(result.conversion.oracle.firstCorrect, 1);
});

test('older lines can change a prediction while the current line stays fixed', () => {
  const result = evaluateCases([{
    mode: 'prediction',
    segments: [{
      reading: 'かいと',
      candidates: segment('かいとう', '回答', '解凍').candidates,
    }],
    acceptedTexts: ['解凍'],
    context: '解凍する肉を用意した。\n作業は明日進める。\n',
  }]);
  assert.equal(result.prediction.baseline.firstCorrect, 0);
  assert.equal(result.prediction.baseline.topThreeCorrect, 1);
  assert.equal(result.prediction.currentLine.firstCorrect, 0);
  assert.equal(result.prediction.threeLines.firstCorrect, 1);
});

test('oracle keeps the one-promotion limit and respects correlated alternatives', () => {
  const result = evaluateCases([
    {
      mode: 'conversion',
      segments: [segment('きかい', '機会', '機械'), segment('たいしょう', '大将', '対象')],
      targets: [['機械', '対象']],
    },
    {
      mode: 'conversion',
      segments: [segment('きかい', '機会', '機械'), segment('たいしょう', '大将', '対象')],
      targets: [['機会', '対象'], ['機械', '大将']],
    },
  ]);
  assert.equal(result.conversion.allCandidateReachable, 2);
  assert.equal(result.conversion.baseline.firstCorrect, 0);
  assert.equal(result.conversion.oracle.firstCorrect, 1);
  assert.equal(result.conversion.oracle.totalOperations, 3);
});

test('a missing candidate stays in the denominator and uses the operation cap', () => {
  const result = evaluateCases([
    {
      mode: 'prediction',
      segments: [segment('かき')],
      acceptedTexts: ['柿'],
    },
    {
      mode: 'prediction',
      segments: [segment('かき', '牡蠣', '書き', '掻き', '柿')],
      acceptedTexts: ['柿'],
    },
  ], { operationLimit: 3 });
  assert.equal(result.prediction.cases, 2);
  assert.equal(result.prediction.allCandidateReachable, 1);
  assert.equal(result.prediction.baseline.completed, 0);
  assert.equal(result.prediction.baseline.totalOperations, 6);
  assert.equal(result.prediction.oracle.completed, 1);
});

test('an already-correct baseline is used when the first accepted alternative needs keys', () => {
  const result = evaluateCases([{
    mode: 'conversion',
    segments: [segment('はし', '橋', '箸')],
    targets: [['箸'], ['橋']],
  }]);
  assert.equal(result.conversion.baseline.totalOperations, 1);
});

test('full-text evaluation can find a path without inventing aligned gold labels', () => {
  const result = evaluateCases([{
    mode: 'conversion',
    segments: [segment('はし', '橋', '箸'), segment('おる', '折る')],
    acceptedTexts: ['箸折る'],
  }]);
  assert.equal(result.conversion.allCandidateReachable, 1);
  assert.equal(result.conversion.baseline.totalOperations, 2);
  assert.equal(result.conversion.scoringGroupsWithGold, 0);
});

test('evaluates the same model with older slots masked and rejects dictionary drift', () => {
  const sample = {
    mode: 'conversion',
    segments: [segment('はし', '橋', '箸')],
    targets: [['箸']],
    context: '箸\n\n',
    provenance: { dictionarySha256: 'a'.repeat(64) },
  };
  const model = {
    dictionarySha256: 'a'.repeat(64),
    score: ({ candidate }, lines) => Number(lines[0].text === candidate.value),
  };
  const result = evaluateCases([sample], { model });
  assert.equal(result.conversion.modelCurrentLine.firstCorrect, 0);
  assert.equal(result.conversion.modelThreeLines.firstCorrect, 1);
  assert.throws(() => evaluateCases([{ ...sample, provenance: undefined }], { model }),
    /dictionary/u);
});

test('a partial prediction remains a displayed match but does not complete the target', () => {
  const result = evaluateCases([{
    mode: 'prediction',
    segments: [{ reading: 'かき', candidates: [
      { id: 0, value: '柿', reading: 'か', consumption: 'partial' },
      { id: 1, value: '牡蠣', reading: 'かき', consumption: 'full' },
    ] }],
    targets: [['柿']],
  }]);
  assert.equal(result.prediction.displayedTargetReachable, 1);
  assert.equal(result.prediction.allCandidateReachable, 0);
  assert.equal(result.prediction.baseline.firstCorrect, 0);
  assert.equal(result.prediction.baseline.completed, 0);
});

test('counted operations cannot replace a fixed segment or select command output as text', () => {
  const fixed = { ...segment('はし', '橋', '箸'), fixed: true };
  const command = {
    reading: 'よみ',
    candidates: [{ id: 0, value: '読み', reading: 'よみ', attributes: ['COMMAND_CANDIDATE'] }],
  };
  const result = evaluateCases([
    { mode: 'conversion', segments: [fixed], targets: [['箸']] },
    { mode: 'conversion', segments: [command], targets: [['読み']] },
  ]);
  assert.equal(result.conversion.displayedTargetReachable, 2);
  assert.equal(result.conversion.allCandidateReachable, 0);
  assert.equal(result.conversion.baseline.completed, 0);
});
