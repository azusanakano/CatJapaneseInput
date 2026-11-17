$ErrorActionPreference = 'Stop'
$taskOutput = 'C:\Users\user\Desktop\CatJapaneseInput\reviews\2026-11-17-native-work'
& 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1' -SkipAutomaticLocation -Arch amd64 -HostArch amd64
Push-Location $taskOutput
try {
  & cl.exe /nologo /W4 /EHsc /std:c++20 /utf-8 condition-probe.cc /link ole32.lib msi.lib /out:condition-probe.exe
  if ($LASTEXITCODE -ne 0) { throw 'Condition probe compilation failed' }
  $fixture = Join-Path $taskOutput ('condition-fixture-' + [Guid]::NewGuid().ToString('N') + '.msi')
  & .\condition-probe.exe $fixture
  if ($LASTEXITCODE -ne 0) { throw 'Condition probe execution failed' }
} finally {
  Pop-Location
}
