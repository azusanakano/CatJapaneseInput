import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateCases } from '../lib/evaluate.mjs';
import { loadModel, trainModel } from '../lib/model.mjs';
import { eligiblePromotions, promote, rankCase, scoringGroups } from '../lib/ranking.mjs';
import { exportNativeModel } from '../tools/mozc/export-model.mjs';

const reviewDirectory = dirname(fileURLToPath(import.meta.url));
const root = dirname(reviewDirectory);
const dictionarySha256 = 'a'.repeat(64);
const sample = {
  mode: 'prediction',
  context: '箸',
  acceptedTexts: ['箸'],
  provenance: { dictionarySha256 },
  segments: [{ reading: 'はし', candidates: [
    { id: 0, reading: 'はし', value: '橋', consumption: 'full' },
    { id: 1, reading: 'はし', value: '箸', consumption: 'full' },
  ] }],
};
const report = { node: process.versions.node, unicode: process.versions.unicode, assertions: {} };

// P3 regression: the input has contradictory authoritative consumption data.
const contradictory = structuredClone(sample);
contradictory.segments[0].candidates[1].attributes = ['PARTIALLY_KEY_CONSUMED'];
const partial = structuredClone(contradictory);
partial.segments[0].candidates[1].consumption = 'partial';
const metrics = input => {
  const result = evaluateCases([input]).prediction;
  return {
    scoringGroups: result.scoringGroups,
    allCandidateReachable: result.allCandidateReachable,
    displayedTargetReachable: result.displayedTargetReachable,
    currentLineFirstCorrect: result.currentLine.firstCorrect,
    currentLinePromoted: result.currentLine.promoted,
    oracleFirstCorrect: result.oracle.firstCorrect,
  };
};
const contradictoryResult = metrics(contradictory);
const partialResult = metrics(partial);
assert.equal(contradictoryResult.currentLinePromoted, 1);
assert.equal(partialResult.currentLinePromoted, 0);
assert.equal(contradictoryResult.allCandidateReachable, 1);
assert.equal(partialResult.allCandidateReachable, 0);
const contradictoryModel = trainModel([contradictory], { dictionarySha256, epochs: 1 });
assert.deepEqual(contradictoryModel.trainedModes, ['prediction']);
assert.throws(() => trainModel([partial], { dictionarySha256, epochs: 1 }), /positive/i);
report.confirmedP3Consumption = { input: contradictory, actual: contradictoryResult, whenLabelCorrected: partialResult };

// P3 regression: training and evaluation disagree on explicit null labels.
report.confirmedP3NullLabels = [];
for (const input of [
  { ...sample, targets: null },
  { ...sample, mode: 'conversion', acceptedTexts: null, targets: [['箸']] },
]) {
  const trained = trainModel([input], { dictionarySha256, epochs: 1 });
  let evaluationError;
  try { evaluateCases([input]); } catch (error) { evaluationError = error.message; }
  assert(evaluationError);
  report.confirmedP3NullLabels.push({ mode: input.mode, trainedModes: trained.trainedModes, evaluationError });
}

// An independent Cartesian-product enumerator for documented Down/Right/Enter costs.
const enumerate = (segments, accepted, prediction, limit) => {
  let best = Infinity, first = false, topThree = false, displayed = false;
  function visit(index, text, downKeys, lastChangedSegment, selectable) {
    if (index === segments.length) {
      if (!accepted.includes(text)) return;
      displayed = true;
      if (!selectable) return;
      const cost = downKeys + Math.max(0, lastChangedSegment) + 1;
      best = Math.min(best, cost);
      first ||= downKeys === 0;
      topThree ||= prediction && downKeys < 3;
      return;
    }
    const segment = segments[index];
    for (const [rank, candidate] of segment.candidates.entries()) {
      visit(index + 1, text + candidate.value, downKeys + rank,
        rank > 0 ? index : lastChangedSegment,
        selectable && (!segment.fixed || rank === 0) &&
        !candidate.attributes?.includes('COMMAND_CANDIDATE') &&
        (!prediction || candidate.consumption === 'full'));
    }
  }
  visit(0, '', 0, -1, true);
  return {
    firstCorrect: Number(first), topThreeCorrect: Number(topThree),
    completed: Number(best <= limit), totalOperations: Math.min(best, limit),
    reachable: Number(Number.isFinite(best)), displayed: Number(displayed),
  };
};
let state = 0x6135901;
const next = n => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor(state / 0x1_0000_0000 * n);
};
const modeCounts = { conversion: 0, prediction: 0 };
for (let index = 0; index < 1000; index++) {
  const mode = next(2) ? 'conversion' : 'prediction';
  const count = mode === 'prediction' ? 1 : 1 + next(5);
  const operationLimit = 1 + next(9);
  const segments = Array.from({ length: count }, () => ({
    reading: 'あ', fixed: next(8) === 0,
    candidates: Array.from({ length: next(5) }, (_, id) => ({
      id, reading: 'あ', value: ['A', 'B', 'AB', ''][next(4)],
      consumption: ['full', 'partial', 'unknown'][next(3)],
      ...(next(8) === 0 ? { attributes: ['COMMAND_CANDIDATE'] } : {}),
    })),
  }));
  const acceptedTexts = Array.from({ length: 1 + next(3) }, () =>
    ['A', 'B', 'AB', 'ABA', 'ABAB', 'AAB', 'BAABB'][next(7)]);
  const input = { mode, segments, acceptedTexts };
  const expected = enumerate(segments, acceptedTexts, mode === 'prediction', operationLimit);
  const actual = evaluateCases([input], { operationLimit })[mode];
  for (const name of ['firstCorrect', 'topThreeCorrect', 'completed', 'totalOperations']) {
    assert.equal(actual.baseline[name], expected[name], `baseline case ${index}: ${name}`);
  }
  assert.equal(actual.allCandidateReachable, expected.reachable);
  assert.equal(actual.displayedTargetReachable, expected.displayed);
  const oracle = { ...expected };
  for (const promotion of eligiblePromotions(input)) {
    const alternative = enumerate(promote(input, promotion), acceptedTexts, mode === 'prediction', operationLimit);
    for (const name of ['firstCorrect', 'topThreeCorrect', 'completed']) oracle[name] = Math.max(oracle[name], alternative[name]);
    oracle.totalOperations = Math.min(oracle.totalOperations, alternative.totalOperations);
  }
  for (const name of ['firstCorrect', 'topThreeCorrect', 'completed', 'totalOperations']) {
    assert.equal(actual.oracle[name], oracle[name], `oracle case ${index}: ${name}`);
  }
  modeCounts[mode]++;
}
report.assertions.independentEvaluationEnumerations = { cases: 1000, modeCounts, result: 'PASS' };

// All five protection attributes override an explicit normal kind.
for (const attribute of ['USER_DICTIONARY', 'NO_MODIFICATION', 'COMMAND_CANDIDATE', 'SPELLING_CORRECTION', 'TYPING_CORRECTION']) {
  const input = structuredClone(sample);
  input.segments[0].candidates[1].attributes = [attribute];
  input.segments[0].candidates[1].kind = 'normal';
  assert.deepEqual(scoringGroups(input), []);
  assert.equal(rankCase(input, { score: ({ candidateIndex }) => candidateIndex }).promotion, null);
}
report.assertions.correctedProtectionIssue = 'PASS (five attributes)';

const trained = trainModel([sample], { dictionarySha256, epochs: 1 });
const mutations = [
  ['format', data => { data.format = 'other'; }],
  ['version', data => { data.version++; }],
  ['Unicode version', data => { data.unicodeVersion = '16.0.0'; }],
  ['dictionary hash', data => { data.dictionarySha256 = 'b'.repeat(64); }],
  ['duplicate mode', data => { data.trainedModes = ['conversion', 'conversion']; }],
  ['unknown mode', data => { data.trainedModes = ['unknown']; }],
  ['extra parameter', data => { data.parameters.extra = data.parameters.prediction; }],
  ['missing parameter', data => { delete data.parameters.prediction; }],
  ...[0, -1, NaN, Infinity, 1e40].map(scale => [`scale ${scale}`, data => { data.parameters.firstBias.scale = scale; }]),
  ['INT8 -128', data => { const bytes = Buffer.from(data.parameters.firstBias.values, 'base64'); bytes[0] = 128; data.parameters.firstBias.values = bytes.toString('base64'); }],
  ['noncanonical base64', data => { data.parameters.firstBias.values = Buffer.alloc(64).toString('base64').slice(0, -4) + 'AB=='; }],
];
for (const [name, mutate] of mutations) {
  const data = structuredClone(trained);
  mutate(data);
  assert.throws(() => loadModel(data, { dictionarySha256 }), undefined, name);
  // Export has no external dictionary digest to compare; loadModel does.
  if (name !== 'dictionary hash') assert.throws(() => exportNativeModel(data), undefined, name);
}
report.assertions.malformedModelCases = { count: mutations.length, result: 'PASS' };

// Each fixture is created exclusively in reviews; cleanup touches only those new files.
const prefix = `2026-11-17-model-fixture-${process.pid}-${Date.now()}-`;
const created = [];
const fixture = async (name, data) => {
  const path = join(reviewDirectory, prefix + name);
  await writeFile(path, data, { flag: 'wx' });
  created.push(path);
  return path;
};
const cli = (tool, args) => spawnSync(process.execPath, [join(root, tool), ...args], {
  cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
const fail = (result, pattern) => {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, pattern);
  assert.equal(result.stdout, '');
};
try {
  const inputBytes = Buffer.from(JSON.stringify(sample) + '\n');
  const input = await fixture('input.txt', inputBytes);
  const model = await fixture('model.json', JSON.stringify(trained));
  const exactLimit = await fixture('limit.json', JSON.stringify(trained).padEnd(2 * 1024 ** 2, ' '));
  const overLimit = await fixture('over-limit.json', JSON.stringify(trained).padEnd(2 * 1024 ** 2 + 1, ' '));
  const invalidUtf8 = await fixture('invalid-utf8.txt', Buffer.from([0x7b, 0xff, 0x7d]));
  const invalidJson = await fixture('invalid-json.txt', '\n' + JSON.stringify(sample) + '\n{bad}\n');
  const blank = await fixture('blank.txt', ' \r\n\n');
  const drift = await fixture('drift.txt', inputBytes.toString('utf8') + JSON.stringify({ ...sample, provenance: { dictionarySha256: 'b'.repeat(64) } }) + '\n');
  const output = join(reviewDirectory, prefix + 'trained.json');

  const exact = cli('tools/evaluate.mjs', [input, '--model', exactLimit]);
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(JSON.parse(exact.stdout).prediction.cases, 1);
  fail(cli('tools/evaluate.mjs', [input, '--model', overLimit]), /exceeds 2 MiB/);
  fail(cli('tools/evaluate.mjs', [invalidUtf8]), /encoded data.*valid/i);
  fail(cli('tools/evaluate.mjs', [invalidJson]), /line 3: invalid JSON/);
  fail(cli('tools/evaluate.mjs', [blank]), /input contains no cases/);
  fail(cli('tools/evaluate.mjs', [drift, '--model', model]), /line 2:.*dictionary/);
  fail(cli('tools/train.mjs', [drift, output, '--epochs', '1']), /line 2: dictionary hash differs/);

  const successfulTraining = cli('tools/train.mjs', [input, output, '--epochs', '1']);
  assert.equal(successfulTraining.status, 0, successfulTraining.stderr);
  created.push(output);
  const outputBefore = await readFile(output);
  assert.equal(JSON.parse(outputBefore).trainingSourceSha256, createHash('sha256').update(inputBytes).digest('hex'));
  fail(cli('tools/train.mjs', [input, output, '--epochs', '1']), /EEXIST/);
  assert.deepEqual(await readFile(output), outputBefore);
  report.assertions.cliChecks = {
    result: 'PASS',
    checks: ['2 MiB model accepted', '2 MiB + 1 model rejected', 'invalid UTF-8 rejected', 'JSON line number', 'blank input rejected', 'evaluation dictionary drift rejected at line 2', 'training dictionary drift rejected at line 2', 'training source hash correct', 'existing output unchanged on EEXIST'],
  };
} finally {
  for (const path of created) {
    assert.equal(dirname(resolve(path)), resolve(reviewDirectory));
    assert(path.startsWith(join(reviewDirectory, prefix)));
    await rm(path);
  }
}

console.log(JSON.stringify(report, null, 2));
