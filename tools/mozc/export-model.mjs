import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { loadModel } from '../../lib/model.mjs';

// The byte order here is part of the CATJINT8 v1 native reader contract.
const parameterNames = [
  'embedding', 'firstWeights', 'firstBias', 'secondWeights', 'secondBias', 'conversion', 'prediction',
];
const fixedHeaderSize = 88;

/** Converts a validated UTF-8 JSON model to the fixed-size native INT8 format. */
export function exportNativeModel(model) {
  loadModel(model, { dictionarySha256: model?.dictionarySha256 });
  const header = Buffer.alloc(fixedHeaderSize + parameterNames.length * 8);
  header.write('CATJINT8', 0, 'ascii');
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(0x00110000, 12); // Unicode 17.0.0
  header.write(model.dictionarySha256, 16, 'ascii');
  header[80] = (model.trainedModes.includes('conversion') ? 1 : 0) |
    (model.trainedModes.includes('prediction') ? 2 : 0);
  const weights = parameterNames.map((name, index) => {
    const { scale, values } = model.parameters[name];
    header.writeDoubleLE(scale, fixedHeaderSize + index * 8);
    return Buffer.from(values, 'base64');
  });
  return Buffer.concat([header, ...weights]);
}

async function main(args) {
  if (args.length !== 2) throw new Error('Usage: node tools/mozc/export-model.mjs <model.json> <model.bin>');
  const [input, output] = args;
  const data = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(input));
  await writeFile(output, exportNativeModel(JSON.parse(data)), { flag: 'wx' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
