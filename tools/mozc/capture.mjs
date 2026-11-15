import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readSampleFile } from '../samples.mjs';

const mozcCommit = 'a4541df29db443b49f81cf54665873b68fde9efa';
const maxConversionCandidates = 200;
const protectedAttributes = new Set([
  'USER_DICTIONARY', 'NO_MODIFICATION', 'COMMAND_CANDIDATE',
  'SPELLING_CORRECTION', 'TYPING_CORRECTION',
]);

function requestKind(mode) {
  switch (mode) {
    case 'conversion': return 's';
    case 'prediction': return 'suggest';
    default: return undefined;
  }
}

export function makeRequests(samples) {
  const commands = ['disableuserhistory'];
  for (const [index, sample] of samples.entries()) {
    const command = requestKind(sample?.mode);
    if (!command) throw new Error(`Invalid mode in sample ${index + 1}.`);
    const { reading } = sample;
    if (typeof reading !== 'string' || reading.length === 0 ||
        !reading.isWellFormed() || /[\u0000-\u0020\u007f]/u.test(reading)) {
      throw new Error(`Invalid reading in sample ${index + 1}.`);
    }
    commands.push('reset', `${command} ${reading}`);
  }
  return `${commands.join('\n')}\n`;
}

function parseSegments(lines, sample, invalid) {
  const segments = [];
  let cursor = 0;
  let expectedSegments;
  function take(prefix) {
    const line = lines[cursor++];
    if (!line?.startsWith(prefix)) throw invalid();
    return line.slice(prefix.length);
  }

  while (cursor < lines.length) {
    const header = /^---------- Segment (\d+)\/(\d+) \[(FREE|FIXED_BOUNDARY|FIXED_VALUE)\] ----------$/.exec(lines[cursor++]);
    if (!header || Number(header[1]) !== segments.length) throw invalid();
    const [, , count, segmentType] = header;
    expectedSegments ??= Number(count);
    if (Number(count) !== expectedSegments) throw invalid();

    const reading = lines[cursor++];
    if (!reading) throw invalid();
    const candidates = [];
    const transliterations = [];
    const reportedCounts = new Map();

    while (lines[cursor]?.startsWith('  ')) {
      const row = /^  (-?\d+)\/(\d+) (.*)$/su.exec(lines[cursor++]);
      if (!row) throw invalid();
      const id = Number(row[1]);
      const count = Number(row[2]);
      const isMeta = id < 0;
      const list = isMeta ? transliterations : candidates;
      const expectedId = isMeta ? -list.length - 1 : list.length;
      if (id !== expectedId || count < list.length + 1 ||
          (reportedCounts.has(list) && reportedCounts.get(list) !== count) ||
          (isMeta && candidates.length !== 0)) {
        throw invalid();
      }
      reportedCounts.set(list, count);

      const candidateReading = lines[cursor]?.startsWith('       key: ')
        ? take('       key: ') : reading;
      take('       content_vk: ');
      const costs = /^(-?\d+)  scost: -?\d+  wcost: -?\d+$/.exec(take('       cost: '));
      if (!costs) throw invalid();
      take('       lid: ');
      take('       rid: ');
      const attributeText = take('       attr: ');
      if (attributeText && !/^[A-Z_]+(?: \| [A-Z_]+)*$/.test(attributeText)) throw invalid();
      const attributes = attributeText ? attributeText.split(' | ') : [];
      take('       num_style: ');
      if (lines[cursor]?.startsWith('       segbdd: ')) cursor++;
      if (lines[cursor] === '       log:') {
        cursor++;
        while (lines[cursor]?.startsWith('           ')) cursor++;
      }

      const candidate = {
        id,
        value: row[3],
        reading: candidateReading,
        kind: isMeta || attributes.some((name) => protectedAttributes.has(name)) ? 'protected' : 'normal',
        cost: Number(costs[1]),
        attributes,
      };
      if (sample.mode === 'prediction') {
        if (attributes.includes('PARTIALLY_KEY_CONSUMED')) {
          candidate.consumption = 'partial';
        } else {
          candidate.consumption = !isMeta && expectedSegments === 1 && reading === sample.reading && candidateReading
            ? 'full' : 'unknown';
        }
      }
      list.push(candidate);
    }

    if ([...reportedCounts].some(([list, count]) => list.length !== count)) {
      throw invalid();
    }
    segments.push({ reading, fixed: segmentType === 'FIXED_VALUE', segmentType, candidates, transliterations });
  }
  if (segments.length !== expectedSegments) throw invalid();
  return segments;
}

export function parseCapture(stdout, samples) {
  const lines = stdout.split(/\r?\n/u);
  const startupPrefixes = ['Data file: ', 'id.def: ', 'User profile dir: '];
  if (lines[0] !== 'Engine type: desktop' ||
      !startupPrefixes.every((prefix, i) => lines[i + 1]?.startsWith(prefix)) || lines[4] !== '') {
    throw new Error('Unexpected converter_main startup output.');
  }

  let cursor = 5;
  const records = samples.map((sample, index) => {
    const invalid = () => new Error(`Invalid converter_main response for sample ${index + 1}.`);
    if (lines[cursor++] !== '') throw invalid(); // reset response
    const start = cursor;
    const response = lines[cursor];
    if (response === 'ExecCommand() return false' || response === '') {
      cursor++;
      return {
        ...sample,
        segments: [{ reading: sample.reading, candidates: [] }],
        candidateStatus: response === '' ? 'no-candidates' : 'no-result',
      };
    }
    while (cursor < lines.length && lines[cursor] !== '') cursor++;
    if (cursor === lines.length) throw invalid();
    const segments = parseSegments(lines.slice(start, cursor), sample, invalid);
    cursor++;
    return { ...sample, segments, candidateStatus: 'captured' };
  });
  if (cursor !== lines.length - 1 || lines[cursor] !== '') {
    throw new Error('Unexpected trailing converter_main output.');
  }
  return records;
}

function validateCheckout(checkout) {
  const head = spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (head.status !== 0 || head.stdout.trim() !== mozcCommit) {
    throw new Error(`Mozc checkout must be at ${mozcCommit}.`);
  }
  const diff = spawnSync('git', ['-C', checkout, 'diff', '--quiet', 'HEAD', '--']);
  if (diff.status !== 0) throw new Error('Mozc checkout must have clean tracked files.');
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function capture(checkout, executable, dictionary, input) {
  validateCheckout(checkout);
  const [{ rows }, converterSha256, dictionarySha256] = await Promise.all([
    readSampleFile(input), sha256(executable), sha256(dictionary),
  ]);
  const samples = rows.map(({ sample }) => sample);
  const requests = makeRequests(samples);
  const profileParent = resolve(tmpdir());
  const profile = await mkdtemp(join(profileParent, 'cat-ime-mozc-'));
  if (dirname(resolve(profile)) !== profileParent) throw new Error('Unexpected temporary profile path.');
  try {
    const result = spawnSync(executable, [
      '--engine_type=desktop',
      '--engine_name=oss',
      `--engine_data_path=${dictionary}`,
      `--id_def=${join(checkout, 'src', 'data', 'dictionary_oss', 'id.def')}`,
      `--user_profile_dir=${profile}`,
      `--log_dir=${profile}`,
      `--max_conversion_candidates_size=${maxConversionCandidates}`,
      '--max_candidates_to_show=2147483647',
      '--show_meta_candidates',
    ], {
      cwd: join(checkout, 'src'),
      input: requests,
      maxBuffer: 128 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const reason = result.error?.code ?? result.signal ?? result.status;
      throw new Error(`converter_main failed (${reason}).`);
    }
    const stdout = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    const records = parseCapture(stdout, samples);
    for (const record of records) {
      record.provenance = {
        ...record.provenance,
        source: 'mozc-converter-main',
        checkoutCommit: mozcCommit,
        converterSha256,
        dictionarySha256,
        request: record.mode === 'conversion' ? 'CONVERSION' : 'SUGGESTION',
        profile: 'fresh-no-history',
        maxConversionCandidates,
      };
    }
    return records;
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 2 });
  }
}

async function main(args) {
  const { positionals, values } = parseArgs({
    args,
    options: { help: { type: 'boolean' }, output: { type: 'string' } },
    allowPositionals: true,
  });
  const usage = 'Usage: node tools/mozc/capture.mjs <mozc-checkout> <converter_main.exe> <mozc.data> <samples.jsonl> [--output <capture.jsonl>]';
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length !== 4) throw new Error(usage);
  const records = await capture(...positionals.map(path => resolve(path)));
  if (values.output !== undefined) {
    const result = records.map(record => JSON.stringify(record)).join('\n') + '\n';
    await writeFile(values.output, result, { flag: 'wx' });
  } else {
    for (const record of records) process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
