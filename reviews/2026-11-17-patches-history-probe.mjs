import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const executable = 'C:/Users/user/AppData/Local/Temp/catj-english-verify-acad4c075db146dd9bf5dd590c35d35f/session_handler_main.exe';
const sha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
const results = [];
for (const fixture of ['absent', 'empty', 'new-revision']) {
  const root = resolve('reviews', '2026-11-17-patches-runtime-' + randomUUID());
  await mkdir(root);
  const input = resolve('reviews', '2026-11-17-patches-history-' + fixture + '.tsv');
  const profile = resolve(root, 'profile');
  const result = spawnSync(executable, ['--dictionary=oss', '--test', '--profile=' + profile, '--input=' + input, '--log_dir=' + root], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  results.push({fixture, executable, executableSha256: sha256, input, profile, status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr});
}
await writeFile(resolve('reviews', '2026-11-17-patches-history-results.json'), JSON.stringify(results, null, 2) + '\n');
for (const result of results) console.log(JSON.stringify(result));
if (results.some(r => r.status !== 0)) process.exitCode = 1;
