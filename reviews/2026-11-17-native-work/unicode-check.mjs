import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractContext, normalizeReading } from '../../lib/context.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const exe = dir + 'probe.exe';
const result = { node: process.version, unicode: process.versions.unicode, icu: process.versions.icu };
const hex = value => Buffer.from(value).toString('hex');
function run(commands) {
  const process = spawnSync(exe, [], { input: commands.join('\n') + '\n', encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  assert.ifError(process.error);
  assert.equal(process.status, 0, process.stderr);
  const lines = process.stdout.trimEnd().split(/\r?\n/u);
  assert.equal(lines.length, commands.length);
  return lines;
}
function parseLines(value) {
  return value.split('\t').map(row => {
    const [state, read, retention, bytes] = row.split(',');
    return { state: ['unavailable', 'empty', 'text'][Number(state)],
      text: Buffer.from(bytes, 'hex').toString('utf8'),
      readTruncated: read === '1', retentionTruncated: retention === '1' };
  });
}
const decode = field => String.fromCodePoint(...field.trim().split(/\s+/u).map(x => Number.parseInt(x, 16)));

const graphemes = readFileSync(dir + 'GraphemeBreakTest.txt', 'utf8').split('\n')
  .map(line => line.split('#')[0].trim()).filter(line => line && !line.startsWith('@'))
  .map(line => {
    const points = [];
    const boundaries = [];
    for (const token of line.split(/\s+/u)) {
      if (token === '÷') boundaries.push(points.length);
      else if (token !== '×') points.push(Number.parseInt(token, 16));
    }
    return { text: String.fromCodePoint(...points), points, boundaries };
  });
const actualBreaks = run(graphemes.map(({ text }) => 'G0' + hex(text)));
actualBreaks.forEach((actual, index) => assert.equal(actual, graphemes[index].boundaries.join(','), `grapheme ${index}`));
result.graphemeCases = graphemes.length;

const normalizations = readFileSync(dir + 'NormalizationTest.txt', 'utf8').split('\n')
  .map(line => line.split('#')[0].trim()).filter(line => line && !line.startsWith('@'))
  .map(line => line.split(';').slice(0, 5).map(decode));
const normInputs = normalizations.flat();
const actualNorms = run(normInputs.map(text => 'N0' + hex(text)));
actualNorms.forEach((actual, index) => {
  const [nfc, reading, bounded] = actual.split('\t');
  const row = normalizations[Math.floor(index / 5)];
  const expectedNfc = index % 5 < 3 ? row[1] : row[3];
  const text = normInputs[index];
  const expectedReading = normalizeReading(text);
  const expectedBounded = text && [...text].length <= 128 && [...expectedReading].length <= 128
    ? hex(expectedReading) : '!';
  assert.equal(nfc, hex(expectedNfc), `NFC conformance ${index}`);
  assert.equal(reading, hex(expectedReading), `reading parity ${index}`);
  assert.equal(bounded, expectedBounded, `bounded parity ${index}`);
});
result.normalizationRows = normalizations.length;
result.normalizationChecks = normInputs.length;

const contexts = [];
for (const source of graphemes) {
  for (let cut = 0; cut <= source.text.length; cut++) {
    for (const clipped of [false, true]) contexts.push({ text: source.text.slice(cut), clipped, source, cut });
  }
}
const chars = ['a', 'か', 'が', '\u3099', '\u0344', '\u0300', '\r', '\n', '\u2028', '\u2029',
  '\ud800', '\udfff', '\u0000', '\u0915', '\u094d', '\u093c', '\u200d', '\u200c',
  '\u0600', '\u1100', '\u1161', '\u11a8', '😀', '🇯', '🇵', '🏽', '👩', 'ﾊ', 'ﾟ', 'ヷ'];
let state = 0x1a2b3c4d;
const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
for (let n = 0; n < 5000; n++) {
  const length = random() % 1250;
  let text = '';
  for (let i = 0; i < length; i++) text += chars[random() % chars.length];
  contexts.push({ text, clipped: !!(random() & 1) });
}
for (const marker of ['a', '😀', '\u0300', '🇯', '👩\u200d', '\u0915\u094d', '\u0600', 'a\u0344']) {
  for (const count of [0, 1, 2, 127, 128, 129, 1023, 1024, 1025, 1100]) {
    for (const clipped of [false, true]) contexts.push({ text: marker.repeat(count), clipped });
  }
}
const actualContexts = run(contexts.map(({ text, clipped }) => `C${+clipped}` + Buffer.from(text, 'utf16le').toString('hex')));
let boundaryChecks = 0;
actualContexts.forEach((actual, index) => {
  const { text, clipped, source, cut } = contexts[index];
  const lines = parseLines(actual);
  assert.deepEqual(lines, extractContext(text, { leftClipped: clipped }), `context parity ${index}`);
  for (const line of lines) {
    assert([...line.text].length <= 128, `point limit ${index}`);
    assert.equal(line.text.normalize('NFC'), line.text, `NFC invariant ${index}`);
    assert(line.text.isWellFormed(), `well-formed invariant ${index}`);
  }
  // Independent check against the official whole-string boundaries, not the JS extractor.
  if (clipped && source && !/[\r\n\u2028\u2029]/u.test(source.text) && lines[2].state === 'text') {
    const allowed = source.boundaries.map(start => String.fromCodePoint(...source.points.slice(start)).normalize('NFC'));
    assert(allowed.includes(lines[2].text), `clipped fragment at non-boundary ${index}, UTF16 cut ${cut}`);
    boundaryChecks++;
  }
});
result.contextCases = contexts.length;
result.independentClippedBoundaryChecks = boundaryChecks;

const invalidBytes = ['80', 'c0af', 'c1bf', 'c2', 'e0', 'e08080', 'eda080', 'edbfbf',
  'f0', 'f0808080', 'f4908080', 'f5808080', 'ff', '61e381', 'e38141'];
const invalidResults = run(invalidBytes.map(bytes => 'N0' + bytes));
invalidResults.forEach((row, index) => assert.equal(row, '!\t!\t!', `malformed UTF8 ${invalidBytes[index]}`));
result.invalidUtf8Cases = invalidBytes.length;
result.status = 'pass';
writeFileSync(dir + 'unicode-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
