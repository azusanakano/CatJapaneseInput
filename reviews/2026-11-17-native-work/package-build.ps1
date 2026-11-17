$ErrorActionPreference = 'Stop'
$taskRoot = 'C:\Users\user\Desktop\CatJapaneseInput'
$taskOutput = Join-Path $taskRoot 'reviews\2026-11-17-native-work'
$nativeSource = Join-Path $taskRoot 'native\mozc'
$abseilSource = 'C:\Users\user\AppData\Local\Temp\catj-bazel\yonud6dp\execroot\_main\external\abseil-cpp+'
& 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1' -SkipAutomaticLocation -Arch amd64 -HostArch amd64
Push-Location $taskOutput
try {
  & cl.exe /nologo /O2 /W4 /EHsc /std:c++20 /utf-8 /J /DUTF8PROC_STATIC /D_WIN32_WINNT=0x0A00 "/I$nativeSource" "/I$taskOutput" "/I$abseilSource" "$nativeSource\catj_packaged_model.cc" packaged-probe.cc catj_context_model.obj utf8proc.obj bcrypt.lib /Fepackaged-probe.exe
  if ($LASTEXITCODE -ne 0) { throw 'Packaged loader compilation failed' }
  & .\packaged-probe.exe
  if ($LASTEXITCODE -ne 0) { throw 'Packaged loader test failed' }
} finally {
  Pop-Location
}
