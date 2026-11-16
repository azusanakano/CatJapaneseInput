$ErrorActionPreference = 'Stop'
$taskRoot = 'C:\Users\user\Desktop\CatJapaneseInput'
$taskOutput = Join-Path $taskRoot 'reviews\2026-11-17-native-work'
$nativeSource = Join-Path $taskRoot 'native\mozc'
$vendorSource = Join-Path $nativeSource 'third_party\utf8proc'
& 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1' -SkipAutomaticLocation -Arch amd64 -HostArch amd64
Push-Location $taskOutput
try {
  & cl.exe /nologo /c /O2 /W4 /utf-8 /DUTF8PROC_STATIC /TC "$vendorSource\utf8proc.c" /Foutf8proc.obj
  if ($LASTEXITCODE -ne 0) { throw 'C compilation failed' }
  & cl.exe /nologo /c /O2 /W4 /EHsc /std:c++20 /utf-8 /DUTF8PROC_STATIC "/I$nativeSource" "/I$vendorSource" "$nativeSource\catj_context.cc" "$nativeSource\catj_context_model.cc"
  if ($LASTEXITCODE -ne 0) { throw 'C++ compilation failed' }
  foreach ($entry in @(
    @{ Source = "$taskOutput\probe.cc"; Target = 'probe.exe' },
    @{ Source = "$taskOutput\model-probe.cc"; Target = 'model-probe.exe' },
    @{ Source = "$nativeSource\catj_context_test.cc"; Target = 'context_test.exe' },
    @{ Source = "$nativeSource\catj_context_model_test.cc"; Target = 'context_model_probe.exe' }
  )) {
    & cl.exe /nologo /O2 /W4 /EHsc /std:c++20 /utf-8 /DUTF8PROC_STATIC "/I$nativeSource" "/I$vendorSource" $entry.Source catj_context.obj catj_context_model.obj utf8proc.obj "/Fe$($entry.Target)"
    if ($LASTEXITCODE -ne 0) { throw "Probe compilation failed: $($entry.Target)" }
  }
  & .\context_test.exe
  if ($LASTEXITCODE -ne 0) { throw 'Existing native context test failed' }
} finally {
  Pop-Location
}
