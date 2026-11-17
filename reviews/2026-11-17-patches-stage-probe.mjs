import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '2026-11-17-patches-stage-fixture');
mkdirSync(root, {recursive:true});
const init = spawnSync('git', ['init','--quiet',root], {encoding:'utf8'});
if (init.status !== 0) throw new Error(init.stderr || 'Fixture repository init failed');
writeFileSync(resolve(root, 'input.txt'), 'before\n');
const patch = resolve(root, 'input.patch');
writeFileSync(patch, 'diff --git a/input.txt b/input.txt\n--- a/input.txt\n+++ b/input.txt\n@@ -1 +1 @@\n-before\n+after\n');
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const ps = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
function runPs(name, command) {
  const process = spawnSync(ps, ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')], {encoding:'utf8'});
  return {name, executable:ps, command, status:process.status, stdout:process.stdout, stderr:process.stderr};
}
const control = spawnSync('git', ['-C',root,'apply','--check','--reverse',patch], {encoding:'utf8'});
const results = [
  runPs('version', '$PSVersionTable.PSVersion.ToString()'),
  {name:'reverse_check_control',status:control.status,stdout:control.stdout,stderr:control.stderr},
  runPs('stage_reverse_check', `$ErrorActionPreference = 'Stop'; git -C ${quote(root)} apply --check --reverse ${quote(patch)} 2>$null; Write-Output 'REACHED-LASTEXITCODE-CHECK'; Write-Output $LASTEXITCODE`),
  runPs('stage_strconv', "$ErrorActionPreference = 'Stop'; [Microsoft.VisualBasic.Strings]::StrConv('test', 'Katakana', 1041)")
];
writeFileSync(resolve(import.meta.dirname,'2026-11-17-patches-stage-results.json'), JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
if (results[1].status !== 1 || results[2].status === 0 || results[2].stdout.includes('REACHED-LASTEXITCODE-CHECK') || results[3].status === 0) process.exitCode = 1;
