// Windows-only probe for R03. Pass the existing Mozc checkout as one argument.
// Creates fresh temporary profiles; it does not install or rebuild anything.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

if (process.platform !== 'win32' || process.argv.length !== 3) {
  throw new Error('Usage on Windows: node reviews/reproduce-native-path.mjs <Mozc checkout>');
}
const checkout = resolve(process.argv[2]);
const root = resolve(tmpdir());
const profileRoot = await mkdtemp(join(root, 'catj-review-confirm-'));
function checkCleanupTarget() {
  if (dirname(resolve(profileRoot)) !== root ||
      !profileRoot.startsWith(join(root, 'catj-review-confirm-'))) {
    throw new Error('Unexpected temporary profile path');
  }
}
checkCleanupTarget();
try {
  for (const suffix of ['ascii', '日本語']) {
    const profile = join(profileRoot, suffix);
    await mkdir(profile);
    const result = spawnSync(join(checkout, 'src', 'bazel-bin', 'converter', 'converter_main.exe'), [
      '--engine_type=desktop', '--engine_name=oss',
      `--engine_data_path=${join(checkout, 'src', 'bazel-bin', 'data_manager', 'oss', 'mozc.data')}`,
      `--id_def=${join(checkout, 'src', 'data', 'dictionary_oss', 'id.def')}`,
      `--user_profile_dir=${profile}`, `--log_dir=${profile}`,
    ], { input: 'disableuserhistory\nreset\ns はし\n', windowsHide: true, timeout: 20_000 });
    if (result.error) throw result.error;
    let decode;
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
      decode = 'UTF-8 OK';
    } catch (error) {
      decode = error.message;
    }
    console.log(JSON.stringify({ pathCase: suffix, exitCode: result.status, decode }));
  }
} finally {
  checkCleanupTarget();
  await rm(profileRoot, { recursive: true, force: true });
}
