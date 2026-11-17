$ErrorActionPreference = 'Stop'
$reviewOut = 'C:\Users\user\Desktop\CatJapaneseInput\reviews\2026-11-17-patches-replay'
$reviewExecroot = 'C:\Users\user\AppData\Local\Temp\catj-bazel\yonud6dp\execroot\_main'
& 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1' -SkipAutomaticLocation -Arch amd64 -HostArch amd64
$reviewUnits = @(
    @{ Name = 'client'; Group = 'client'; Source = 'client/client.cc' },
    @{ Name = 'engine_converter'; Group = 'engine'; Source = 'engine/engine_converter.cc' },
    @{ Name = 'catj_reranker'; Group = 'engine'; Source = 'engine/catj_reranker.cc' }
)
Push-Location $reviewExecroot
try {
    foreach ($unit in $reviewUnits) {
        $compile = @(('"/I' + $reviewOut + '\include"'))
        $params = 'bazel-out\x64_windows-opt\bin\' + $unit.Group + '\_objs\' + $unit.Name + '\' + $unit.Name + '.obj.params'
        $compile += [IO.File]::ReadAllLines((Join-Path $reviewExecroot $params)) | Where-Object { $_ -notmatch '^/Fo|^client/.*[.]cc$|^engine/.*[.]cc$|^--target|^-W|^/showIncludes|^-D__' }
        $compile += '/std:c++20'
        $compile += '"/Fo' + (Join-Path $reviewOut ($unit.Name + '-reviewed.obj')) + '"'
        $compile += '"' + (Join-Path $reviewOut ('include/' + $unit.Source)) + '"'
        $response = Join-Path $reviewOut ($unit.Name + '-reviewed.rsp')
        [IO.File]::WriteAllLines($response, [string[]]$compile)
        & cl.exe ('@' + $response)
        if ($LASTEXITCODE -ne 0) { throw ('Reviewed source compile failed: ' + $unit.Name) }
    }
    $link = [IO.File]::ReadAllLines((Join-Path $reviewOut 'link.rsp')) | ForEach-Object {
        if ($_ -match '^/OUT:') { '/OUT:"' + (Join-Path $reviewOut 'probe-reviewed.exe') + '"' }
        else { $_ }
    }
    foreach ($unit in $reviewUnits) { $link += '"' + (Join-Path $reviewOut ($unit.Name + '-reviewed.obj')) + '"' }
    $link += '/MAP:"' + (Join-Path $reviewOut 'probe-reviewed.map') + '"'
    [IO.File]::WriteAllLines((Join-Path $reviewOut 'link-reviewed.rsp'), [string[]]$link)
    & link.exe ('@' + (Join-Path $reviewOut 'link-reviewed.rsp'))
    if ($LASTEXITCODE -ne 0) { throw 'Reviewed source replay link failed' }
    & (Join-Path $reviewOut 'probe-reviewed.exe') (Join-Path $reviewOut ('profile-reviewed-' + [Guid]::NewGuid().ToString('N')))
    if ($LASTEXITCODE -ne 0) { throw 'Reviewed source replay probe failed' }
} finally { Pop-Location }
