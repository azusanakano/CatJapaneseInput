$ErrorActionPreference = 'Stop'
$replayOut = 'C:\Users\user\Desktop\CatJapaneseInput\reviews\2026-11-17-patches-replay'
$replayExecroot = 'C:\Users\user\AppData\Local\Temp\catj-bazel\yonud6dp\execroot\_main'
$replayOriginalLink = 'C:\Users\user\AppData\Local\Temp\catj-english-verify-acad4c075db146dd9bf5dd590c35d35f\session_handler_main.rsp'
& 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1' -SkipAutomaticLocation -Arch amd64 -HostArch amd64
$compile = @(('"/I' + $replayOut + '\include"'))
$compile += [IO.File]::ReadAllLines((Join-Path $replayExecroot 'bazel-out\x64_windows-opt\bin\session\_objs\session_handler_main\session_handler_main.obj.params')) | Where-Object { $_ -notmatch '^/Fo|^session/|^--target|^-W|^/showIncludes|^-D__' }
$compile += '"/Fo' + (Join-Path $replayOut 'probe.obj') + '"'
$compile += '"' + (Join-Path $replayOut 'probe.cc') + '"'
[IO.File]::WriteAllLines((Join-Path $replayOut 'compile.rsp'), [string[]]$compile)
$link = [IO.File]::ReadAllLines($replayOriginalLink) | ForEach-Object {
  if ($_ -match '^/OUT:') { '/OUT:"' + (Join-Path $replayOut 'probe.exe') + '"' }
  elseif ($_ -match 'session_handler_main[.]obj$') { '"' + (Join-Path $replayOut 'probe.obj') + '"' }
  elseif ($_ -notmatch '^/MANIFESTINPUT:') { $_ }
}
[IO.File]::WriteAllLines((Join-Path $replayOut 'link.rsp'), [string[]]$link)
Push-Location $replayExecroot
try {
  & cl.exe ('@' + (Join-Path $replayOut 'compile.rsp'))
  if ($LASTEXITCODE -ne 0) { throw 'Replay probe compile failed' }
  & link.exe ('@' + (Join-Path $replayOut 'link.rsp'))
  if ($LASTEXITCODE -ne 0) { throw 'Replay probe link failed' }
  & (Join-Path $replayOut 'probe.exe') (Join-Path $replayOut ('profile-' + [Guid]::NewGuid().ToString('N')))
  if ($LASTEXITCODE -ne 0) { throw 'Replay probe failed' }
} finally { Pop-Location }
