import { readFile } from 'node:fs/promises';

export async function readSampleFile(path) {
  const bytes = await readFile(path);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push({ line: index + 1, sample: JSON.parse(line) });
    } catch {
      throw new Error(`line ${index + 1}: invalid JSON`);
    }
  }
  if (!rows.length) throw new Error('the input contains no cases');
  return { bytes, rows };
}
