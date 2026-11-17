#Requires -Version 7.0
param(
    [string] $VcVarsAll = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
    [string] $TsfPatch = (Join-Path $PSScriptRoot '../tools/mozc/catj-context-tsf.patch')
)

$ErrorActionPreference = 'Stop'
$vcvars = (Get-Item -LiteralPath $VcVarsAll).FullName
$patch = (Get-Item -LiteralPath $TsfPatch).FullName
$root = [IO.Directory]::CreateTempSubdirectory('catj-context-history-test-').FullName
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/mozc-history/src') -Destination $root -Recurse
    git -C $root apply --whitespace=error '--include=src/win32/tip/tip_edit_session_impl.cc' $patch
    if ($LASTEXITCODE -ne 0) { throw 'The TSF patch did not apply to the pinned edit-session source.' }
    $source = [IO.File]::ReadAllText((Join-Path $root 'src/win32/tip/tip_edit_session_impl.cc'))
    $function = [regex]::Match($source, '(?s)HRESULT TipEditSessionImpl::OnEndEdit\(.*?\n\}')
    if (!$function.Success) { throw 'OnEndEdit was not found in the patched source.' }
    $harness = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixtures/mozc-history/history-test.cc'))
    $harness = $harness.Replace('// CATJ_ACTUAL_ON_END_EDIT', $function.Value)
    [IO.File]::WriteAllText((Join-Path $root 'context-history-test.cc'), $harness)
    $build = '@call "' + $vcvars + '" x64 >nul' + "`r`n" +
        '@if errorlevel 1 exit /b %errorlevel%' + "`r`n" +
        '@cl /nologo /EHsc /std:c++20 /utf-8 /DUNICODE /D_UNICODE context-history-test.cc /link /out:context-history-test.exe' + "`r`n" +
        '@exit /b %errorlevel%' + "`r`n"
    [IO.File]::WriteAllText((Join-Path $root 'build.cmd'), $build)
    Push-Location $root
    try {
        & $env:ComSpec /d /c build.cmd
        if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the actual patched OnEndEdit function.' }
        & (Join-Path $root 'context-history-test.exe')
        if ($LASTEXITCODE -ne 0) { throw 'Context history behavior tests failed.' }
    } finally { Pop-Location }
} finally {
    $resolvedRoot = (Resolve-Path -LiteralPath $root).ProviderPath
    $tempParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedRoot) -like 'catj-context-history-test-*') {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
