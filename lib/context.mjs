const readLimit = 1_024;
const lineLimit = 3;
const codePointLimit = 128;

// This offline implementation uses ICU. The production IME uses pinned utf8proc.
if (!/^17\.0(?:\.0)?$/.test(process.versions.unicode)) {
  throw new Error('Context preprocessing requires Node.js with Unicode 17.0 data.');
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

// UAX #29 rev. 47 has three rules whose lookbehind can extend past both
// code points at a boundary. These prefixes supply the missing Indic linker
// context (GB9c), extended pictograph (GB11), and RI parity (GB12/13).
const prefixes = ['\u0915\u094d', '\u{1f600}', '\u{1f1e6}'];

function confirmedStart(line) {
  let boundaries = Array.from(graphemes.segment(line), ({ index }) => index).slice(1);
  for (const prefix of prefixes) {
    if (boundaries.length === 0) break;
    const withPrefix = new Set(Array.from(graphemes.segment(prefix + line),
      ({ index }) => index - prefix.length));
    boundaries = boundaries.filter(index => withPrefix.has(index));
  }
  return boundaries[0] ?? line.length;
}

function retainSuffix(line) {
  const clusters = Array.from(graphemes.segment(line));
  let remaining = codePointLimit;
  let start = line.length;
  for (const { segment, index } of clusters.reverse()) {
    remaining -= Array.from(segment).length;
    if (remaining < 0) break;
    start = index;
  }
  return line.slice(start);
}

function unavailable(readTruncated = false, retentionTruncated = false) {
  return { state: 'unavailable', text: '', readTruncated, retentionTruncated };
}

function prepareLine(line, readTruncated) {
  if (!line.isWellFormed()) return unavailable(readTruncated);
  if (readTruncated) {
    line = line.slice(confirmedStart(line));
    if (line.length === 0) return unavailable(true);
  }

  const retained = retainSuffix(line);
  const normalized = retained.normalize('NFC');
  const text = retainSuffix(normalized);
  const retentionTruncated = retained.length < line.length || text.length < normalized.length;
  if (!text && retentionTruncated) return unavailable(readTruncated, true);
  return { state: text ? 'text' : 'empty', text, readTruncated, retentionTruncated };
}

/** Builds NFC features from confirmed left-of-anchor text. Null means unacquired. */
export function extractContext(text, { leftClipped = false } = {}) {
  if (text === null) return Array.from({ length: lineLimit }, () => unavailable());
  if (typeof text !== 'string' || typeof leftClipped !== 'boolean') {
    throw new TypeError('Context must be a string or null, and leftClipped must be a boolean.');
  }

  const start = Math.max(0, text.length - readLimit);
  const clipped = leftClipped || start > 0;
  let suffix = text.slice(start);
  const couldSplitPair = start === 0 || /^[\uD800-\uDBFF]$/.test(text[start - 1]);
  if (clipped && couldSplitPair && /^[\uDC00-\uDFFF]/.test(suffix)) {
    suffix = suffix.slice(1);
  }

  const lines = suffix.split(/\r\n|[\n\r\u2028\u2029]/u);
  const first = Math.max(0, lines.length - lineLimit);
  const features = lines.slice(first).map((line, index) =>
    prepareLine(line, clipped && first + index === 0));
  const unacquired = Array.from({ length: lineLimit - features.length }, () => unavailable(clipped));
  return [...unacquired, ...features];
}

/** Folds kana for comparison while preserving the original candidate and reading. */
export function normalizeReading(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) {
    throw new TypeError('Reading must be well-formed UTF-16.');
  }

  const wideKana = text.replace(/[\uFF66-\uFF9F]+/gu, run => run.normalize('NFKC'));
  // Decompose voiced kana so exceptional forms such as ヷ also fold.
  return wideKana.normalize('NFD')
    .replace(/[\u30A1-\u30F6\u30FD-\u30FE]/gu,
      kana => String.fromCharCode(kana.charCodeAt(0) - 0x60))
    .normalize('NFC');
}
