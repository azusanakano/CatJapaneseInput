import assert from 'node:assert/strict';
import test from 'node:test';

import { extractContext, normalizeReading } from '../lib/context.mjs';

const unavailable = {
  state: 'unavailable', text: '', readTruncated: false, retentionTruncated: false,
};
const empty = { ...unavailable, state: 'empty' };
const cut = { ...unavailable, readTruncated: true };

function present(text, flags = {}) {
  return { ...empty, state: 'text', text, ...flags };
}

test('leaves confirmed empty lines in place and counts CRLF once', () => {
  assert.deepEqual(extractContext('対象外\r\n前\u2028\u2029現在'), [
    present('前'), empty, present('現在'),
  ]);
  assert.deepEqual(extractContext('一\r\n二\r三'), [present('一'), present('二'), present('三')]);
  assert.deepEqual(extractContext('\n\n'), [empty, empty, empty]);
});

test('distinguishes no acquisition, an empty field, and a line of spaces', () => {
  assert.deepEqual(extractContext(null), [unavailable, unavailable, unavailable]);
  assert.deepEqual(extractContext(''), [unavailable, unavailable, empty]);
  assert.deepEqual(extractContext(' '), [unavailable, unavailable, present(' ')]);
});

test('bounds a long current line without filling older lines', () => {
  assert.deepEqual(extractContext('古い行\n' + 'あ'.repeat(1_100)), [
    cut, cut, present('あ'.repeat(128), { readTruncated: true, retentionTruncated: true }),
  ]);
});

test('recognizes a leading LF in a clipped CRLF without inventing an empty line', () => {
  assert.deepEqual(extractContext('前\r\n' + 'あ'.repeat(1_023)), [
    cut, cut, present('あ'.repeat(128), { retentionTruncated: true }),
  ]);
  assert.deepEqual(extractContext('\n今', { leftClipped: true }), [cut, cut, present('今')]);
});

test('drops a split low surrogate at the left edge and rejects other malformed UTF-16', () => {
  assert.deepEqual(extractContext('😀' + 'あ'.repeat(1_023))[2],
    present('あ'.repeat(128), { readTruncated: true, retentionTruncated: true }));
  assert.deepEqual(extractContext('一\ud800行\r\n前\n今'), [unavailable, present('前'), present('今')]);
  assert.deepEqual(extractContext('一\n二\udc00\n三'), [present('一'), unavailable, present('三')]);
});

test('resumes clipped lines only at a known grapheme boundary', () => {
  for (const prefix of ['\u0301\u0300', '\u200d👧', '🇯🇵🇨🇦🇺', '\u094dक']) {
    assert.deepEqual(extractContext(prefix, { leftClipped: true }), [cut, cut, cut]);
    assert.deepEqual(extractContext(prefix + '猫', { leftClipped: true })[2],
      present('猫', { readTruncated: true }));
  }
  assert.deepEqual(extractContext('あい', { leftClipped: true })[2],
    present('い', { readTruncated: true }));
  assert.deepEqual(extractContext('😀😀', { leftClipped: true })[2],
    present('😀', { readTruncated: true }));
});

test('cuts an entire grapheme when its left end exceeds the retention limit', () => {
  for (const prefix of ['👨‍👩‍👧‍👦', '🇯🇵', 'か\u3099']) {
    assert.deepEqual(extractContext(prefix + 'あ'.repeat(127))[2],
      present('あ'.repeat(127), { retentionTruncated: true }));
  }
  assert.deepEqual(extractContext('a' + '\u0300'.repeat(129))[2],
    { ...unavailable, retentionTruncated: true });
});

test('caps the feature copy again after NFC expansion', () => {
  assert.deepEqual(extractContext('か\u3099')[2], present('が'));
  assert.deepEqual(extractContext('あ'.repeat(127) + '\u0344')[2],
    present('あ'.repeat(126) + '\u0308\u0301', { retentionTruncated: true }));
});

test('unifies kana width and script before NFC without folding unrelated characters', () => {
  assert.equal(normalizeReading('カイﾄｳ・カ\u3099・ヷ・ヾ・Ａ'), 'かいとう・が・わ\u3099・ゞ・Ａ');
  assert.throws(() => normalizeReading('\ud800'), TypeError);
});
