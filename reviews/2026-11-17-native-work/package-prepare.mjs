import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const binary = readFileSync(dir + 'probe-model.bin');
const dictionary = Buffer.from('catj-review-dictionary\0with-null', 'utf8');
binary.write(createHash('sha256').update(dictionary).digest('hex'), 16, 'ascii');
const values = [];
for (let offset = 0; offset < binary.length; offset += 8) values.push('0x' + binary.readBigUInt64LE(offset).toString(16));
mkdirSync(dir + 'catj', { recursive: true });
writeFileSync(dir + 'catj/catj_model_data.inc', 'constexpr uint64_t kCatjContextModel_data[] = {\n' +
  values.map((value, index) => value + (index % 4 === 3 ? ',\n' : ', ')).join('') + '\n};\n' +
  `constexpr EmbeddedFile kCatjContextModel = { kCatjContextModel_data, ${binary.length} };\n`);
console.log(createHash('sha256').update(dictionary).digest('hex'));
