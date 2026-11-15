import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { makeRequests, parseCapture } from './capture.mjs';

const startup = [
  'Engine type: desktop',
  'Data file: test/mozc.data',
  'id.def: test/id.def',
  'User profile dir: test/profile',
  '', // disableuserhistory
].join('\r\n') + '\r\n';

function candidate(id, count, value, { reading, attributes = '', cost = 17 } = {}) {
  return [
    `  ${id}/${count} ${value}`,
    ...(reading === undefined ? [] : [`       key: ${reading}`]),
    '       content_vk: value  reading',
    `       cost: ${cost}  scost: 0  wcost: 1`,
    '       lid: 1',
    '       rid: 2',
    `       attr: ${attributes}`,
    '       num_style: DEFAULT_STYLE',
  ];
}

function output(...lines) {
  return startup + [...lines, ''].join('\r\n');
}

test('capture sends only independent conversion and automatic suggestion commands', () => {
  const samples = [
    { id: 'space', mode: 'conversion', reading: 'はし' },
    { id: 'suggest', mode: 'prediction', reading: 'かいと' },
  ];
  assert.equal(makeRequests(samples), 'disableuserhistory\nreset\ns はし\nreset\nsuggest かいと\n');
});

test('reading is rejected when it would change the upstream command or its tokenization', () => {
  for (const reading of ['', 'a b', 'a\r', 'a\ns a', 'a\tb', '\ud800']) {
    assert.throws(() => makeRequests([{ mode: 'conversion', reading }]), /sample 1/);
  }
});

test('segment boundaries, ranks, protected attributes and raw surfaces survive capture', () => {
  const samples = [{ id: 'space', mode: 'conversion', reading: 'はしを', acceptedTexts: ['箸を'] }];
  const [record] = parseCapture(output(
    '', // reset
    '---------- Segment 0/2 [FREE] ----------',
    'はし',
    ...candidate(-1, 1, 'ハシ'),
    ...candidate(0, 2, '橋'),
    ...candidate(1, 2, ' 箸 ', { attributes: 'BEST_CANDIDATE | NO_MODIFICATION', cost: -4 }),
    '---------- Segment 1/2 [FIXED_VALUE] ----------',
    'を',
    ...candidate(0, 1, 'を'),
    '', // end of response
  ), samples);
  assert.deepEqual(record.acceptedTexts, ['箸を']);
  assert.equal(record.id, 'space');
  assert.equal(record.segments[1].fixed, true);
  assert.deepEqual(record.segments[0].candidates.map(({ id, value, reading, kind, cost }) =>
    [id, value, reading, kind, cost]), [
    [0, '橋', 'はし', 'normal', 17],
    [1, ' 箸 ', 'はし', 'protected', -4],
  ]);
  assert.deepEqual(record.segments[0].transliterations.map(({ id, value, kind }) =>
    [id, value, kind]), [[-1, 'ハシ', 'protected']]);
});

test('predictions distinguish explicitly partial, verified full, and unmapped readings', () => {
  const samples = ['かいと', 'カイト'].map((reading) => ({ mode: 'prediction', reading }));
  const records = parseCapture(output(
    '',
    '---------- Segment 0/1 [FREE] ----------',
    'かいと',
    ...candidate(0, 2, '回答', { reading: 'かいとう' }),
    ...candidate(1, 2, '貝', { reading: 'かい', attributes: 'PARTIALLY_KEY_CONSUMED' }),
    '',
    '',
    '---------- Segment 0/1 [FREE] ----------',
    'かいと',
    ...candidate(0, 1, '解凍', { reading: 'かいとう' }),
    '',
  ), samples);
  assert.deepEqual(records[0].segments[0].candidates.map((row) => row.consumption), ['full', 'partial']);
  assert.equal(records[1].segments[0].candidates[0].consumption, 'unknown');
});

test('blank and rejected responses stay in the evaluation set without shifting later samples', () => {
  const samples = ['あ', 'う', 'い'].map((reading) => ({ mode: 'prediction', reading }));
  const records = parseCapture(output(
    '',
    'ExecCommand() return false',
    '',
    '',
    '',
    '---------- Segment 0/1 [FREE] ----------',
    'い',
    ...candidate(0, 1, '意'),
    '',
  ), samples);
  assert.deepEqual(records[0].segments, [{ reading: 'あ', candidates: [] }]);
  assert.equal(records[0].candidateStatus, 'no-result');
  assert.deepEqual(records[1].segments, [{ reading: 'う', candidates: [] }]);
  assert.equal(records[1].candidateStatus, 'no-candidates');
  assert.equal(records[2].segments[0].candidates[0].value, '意');
});

test('a truncated or unrecognized response fails closed without echoing the sample', () => {
  const samples = [{ mode: 'prediction', reading: 'かいと' }];
  const truncated = output('', '---------- Segment 0/1 [FREE] ----------', 'かいと',
    ...candidate(0, 2, '回答'), '');
  assert.throws(() => parseCapture(truncated, samples), (error) => {
    assert.match(error.message, /sample 1/);
    assert.doesNotMatch(error.message, /かいと|回答/);
    return true;
  });
});

const nativeCheckout = process.env.CATJ_MOZC_CHECKOUT;
test('Windows capture accepts Japanese checkout, executable, dictionary and TEMP paths', {
  skip: process.platform !== 'win32' || !nativeCheckout ? 'requires a built Mozc checkout in CATJ_MOZC_CHECKOUT' : false,
}, async (t) => {
  const tempParent = resolve(tmpdir());
  const root = await mkdtemp(join(tempParent, 'catj-capture-test-'));
  assert.equal(dirname(resolve(root)), tempParent);
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 2 }));

  const source = resolve(nativeCheckout);
  const checkout = join(root, '作業 フォルダー');
  const git = (path, ...args) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8' }).trimEnd();
  const objects = git(source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects');
  const commit = git(source, 'rev-parse', 'HEAD');
  await mkdir(checkout);
  git(checkout, 'init', '--quiet');
  await writeFile(join(checkout, '.git', 'objects', 'info', 'alternates'), objects + '\n');
  git(checkout, 'sparse-checkout', 'set', '--no-cone', '/src/data/dictionary_oss/id.def');
  git(checkout, 'checkout', '--quiet', '--detach', commit);

  const executable = join(root, '変換器.exe');
  const dictionary = join(root, '辞書 = 日本語.data');
  const input = join(root, '入力.jsonl');
  const output = join(root, '出力.jsonl');
  const profileParent = join(root, '一時 フォルダー');
  await Promise.all([
    copyFile(join(source, 'src', 'bazel-bin', 'converter', 'converter_main.exe'), executable),
    copyFile(join(source, 'src', 'bazel-bin', 'data_manager', 'oss', 'mozc.data'), dictionary),
    mkdir(profileParent),
    writeFile(input, JSON.stringify({ mode: 'conversion', reading: 'にほんご', acceptedTexts: ['日本語'] }) + '\n'),
  ]);

  const cli = fileURLToPath(new URL('./capture.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(TEMP|TMP)$/i.test(name)));
  const result = spawnSync(process.execPath, [cli, checkout, executable, dictionary, input, '--output', output], {
    encoding: 'utf8', timeout: 130_000, windowsHide: true,
    env: { ...env, TEMP: profileParent, TMP: profileParent },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(profileParent), []);
  const record = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(record.candidateStatus, 'captured');
  assert.equal(record.segments[0].candidates[0].value, '日本語');
});
