import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractContext, normalizeReading } from '../../lib/context.mjs';
import { loadModel } from '../../lib/model.mjs';
import { exportNativeModel } from '../../tools/mozc/export-model.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const hash = 'a'.repeat(64);
const lengths = { embedding: 32768 * 32, firstWeights: 341 * 64, firstBias: 64,
  secondWeights: 64 * 32, secondBias: 32, conversion: 32, prediction: 32 };
let randomState = 0x7f41ca21;
const random = () => (randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0);
const parameters = Object.fromEntries(Object.entries(lengths).map(([name, length]) => [name, {
  scale: 0.002 + (random() % 2000) / 1000000,
  values: Buffer.from(Int8Array.from({ length }, () => (random() % 255) - 127).buffer).toString('base64'),
}]));
const data = { format: 'cat-japanese-input-context-model', version: 1, unicodeVersion: '17.0.0',
  dictionarySha256: hash, trainedModes: ['conversion', 'prediction'], parameters };
const path = dir + 'probe-model.bin';
writeFileSync(path, exportNativeModel(data));
const score = loadModel(data, { dictionarySha256: hash });
const hex = value => Buffer.from(value).toString('hex') || '-';
const bytes = value => Buffer.from([value]).toString('hex');
const floatHex = value => { const buffer = Buffer.alloc(8); buffer.writeDoubleLE(value); return buffer.toString('hex'); };
function run(commands) {
  const process = spawnSync(dir + 'model-probe.exe', [path], { input: commands.join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  assert.ifError(process.error);
  assert.equal(process.status, 0, process.stderr);
  const lines = process.stdout.trimEnd().split(/\r?\n/u);
  assert.equal(lines.length, commands.length);
  return lines;
}
const result = { status: 'running' };
let maxAbsoluteDifference = 0;
function equivalent(actual, expected, description) {
  if (Number.isNaN(expected)) assert(Number.isNaN(actual), description);
  else {
    assert(Number.isFinite(actual) && Number.isFinite(expected), description);
    const error = Math.abs(actual - expected);
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, error);
    assert(error <= 1e-11 * Math.max(1, Math.abs(expected)), `${description}: ${actual} != ${expected}`);
  }
}
const cases = [];
const strings = ['a', '回答', '解凍', 'カイﾄｳ', 'ヷ', 'か\u3099', 'Ａ', '😀', '🇯🇵', '👩\u200d👩',
  '\u0344', '\u0915\u094d\u0915', 'x\0é', 'ﾊﾟﾋﾟﾌﾟﾍﾟﾎﾟ'];
for (let n = 0; n < 1200; n++) {
  const previous = { reading: strings[random() % strings.length], fixed: !!(random() & 1),
    candidates: [{ value: n % 13 === 0 ? 'a'.repeat(129) : strings[random() % strings.length] }] };
  const next = { reading: n % 17 === 0 ? 'a'.repeat(129) : strings[random() % strings.length],
    fixed: !!(random() & 1), candidates: [{ value: strings[random() % strings.length] }] };
  const candidate = { reading: strings[random() % strings.length], value: strings[random() % strings.length],
    cost: [0, -2147483648, 2147483647, 1200, undefined, Number.MAX_VALUE, -Number.MAX_VALUE][n % 7] };
  const baseline = { reading: 'a', value: 'base',
    cost: [1250, undefined, Number.MAX_VALUE, -Number.MAX_VALUE][n % 4] };
  const candidateIndex = [0, 1, 8, 50, Number.MAX_SAFE_INTEGER, undefined][n % 6];
  const segment = { reading: strings[random() % strings.length], candidates: [baseline, candidate] };
  const context = (strings[random() % strings.length] + '\n' + strings[random() % strings.length] + '\n' +
    strings[random() % strings.length]).repeat(n % 9 === 0 ? 130 : 1);
  const leftClipped = !!(random() & 1);
  const sample = { mode: n % 2 ? 'conversion' : 'prediction', segments: [previous, segment, next] };
  const fields = [segment.reading, candidate.reading, candidate.value, previous.reading,
    previous.candidates[0].value, next.reading, next.candidates[0].value];
  const command = ['S', sample.mode === 'conversion' ? 0 : 1, +leftClipped,
    Buffer.from(context, 'utf16le').toString('hex') || '-', +previous.fixed, +next.fixed,
    ...fields.map(hex), candidateIndex ?? '-', candidate.cost ?? '-', baseline.cost ?? '-'].join(' ');
  cases.push({ command, expected: score({ sample, segment, segmentIndex: 1, candidate, candidateIndex },
    extractContext(context, { leftClipped })) });
}
run(cases.map(c => c.command)).forEach((value, i) => equivalent(Number(value), cases[i].expected, `score parity ${i}`));
result.scoreParityCases = cases.length;
result.maxAbsoluteDifference = maxAbsoluteDifference;

const modes = run(Array.from({ length: 256 }, (_, mode) => `B 80 ${bytes(mode)}`));
modes.forEach((line, mode) => {
  const [loaded, conversion, conversionScore, prediction, predictionScore] = line.split(' ').map(Number);
  assert.equal(loaded, +(mode <= 3), `mode ${mode}`);
  if (loaded) {
    assert.equal(conversion, +(!!(mode & 1)));
    assert.equal(prediction, +(!!(mode & 2)));
    if (!conversion) assert.equal(conversionScore, 0);
    if (!prediction) assert.equal(predictionScore, 0);
  }
});
result.modeValues = 256;

const midpoint = 2 ** 128 - 2 ** 103;
const edge = midpoint / 127;
const scales = [0, -0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE, 2 ** -1022, 1,
  Number.MAX_VALUE, edge * (1 - Number.EPSILON), edge, edge * (1 + Number.EPSILON)];
const scaleCommands = Object.keys(lengths).flatMap((_, index) => scales.map(value => `B ${88 + index * 8} ${floatHex(value)}`));
run(scaleCommands).forEach((line, i) => {
  const value = scales[i % scales.length];
  const expected = Number.isFinite(value) && value > 0 && Number.isFinite(Math.fround(127 * value));
  assert.equal(line.startsWith('1'), expected, `scale parity ${i}: ${value}`);
});
result.scaleBoundaryCases = scaleCommands.length;

const invalid = [
  'B 0 00', 'B 8 02000000', 'B 12 00001000',
  ...Array.from({ length: 7 }, (_, index) => `B ${81 + index} 01`),
  ...[0, 1, 1072751, 1072753].map(size => `T ${size}`),
  ...['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'b'.repeat(64)].map(value => `H ${hex(value)}`),
];
let offset = 144;
for (const length of Object.values(lengths)) {
  invalid.push(`B ${offset} 80`, `B ${offset + length - 1} 80`);
  offset += length;
}
run(invalid).forEach((actual, index) => assert.equal(actual, '0', `invalid envelope ${invalid[index]}`));
result.invalidEnvelopeCases = invalid.length;

const badFeatures = ['', 'a'.repeat(129), 'q'.repeat(127) + '\u0344'].flatMap(text =>
  [0, 1, 2].map(field => {
    const fields = ['a', 'a', 'a', '', '', '', ''];
    fields[field] = text;
    return ['S', 0, 0, '-', 0, 0, ...fields.map(hex), '-', '-', '-'].join(' ');
  }));
badFeatures.push('S 0 0 - 0 0 eda080 61 61 - - - - - - -');
const badScores = run(badFeatures);
badScores.forEach((actual, index) => assert(Number.isNaN(Number(actual)), `bad required feature ${index}: ${actual}`));
result.invalidRequiredFeatureCases = badFeatures.length;
result.status = 'pass';
writeFileSync(dir + 'model-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
