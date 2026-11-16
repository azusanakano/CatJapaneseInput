#Requires -Version 7.0
[CmdletBinding(DefaultParameterSetName = 'CertificateStore')]
param(
    [Parameter(Mandatory)]
    [string] $SignToolPath,

    [Parameter(Mandatory, ParameterSetName = 'CertificateStore')]
    [string] $CertificateThumbprint,

    [Parameter(Mandatory, ParameterSetName = 'CertificateStore')]
    [string] $TimestampUrl,

    [Parameter(Mandatory, ParameterSetName = 'SigningService')]
    [switch] $SigningService
)

$ErrorActionPreference = 'Stop'

function Expand-ReleaseCandidate([string] $path, [string] $destination) {
    $recordedHash = (Get-Content -LiteralPath "$path.sha256" -Raw).TrimEnd()
    $stream = [IO.File]::OpenRead($path)
    try {
        $hash = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
        if ($recordedHash -ne "$hash  $([IO.Path]::GetFileName($path))") {
            throw '署名前 ZIP の SHA-256 が一致しません。'
        }
        $stream.Position = 0
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            [IO.Compression.ZipFileExtensions]::ExtractToDirectory($archive, $destination)
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
}

function Assert-ReleaseArchive([string] $path, [Collections.Generic.Dictionary[string, string]] $hashes) {
    $archive = [IO.Compression.ZipFile]::OpenRead($path)
    try {
        if ($archive.Entries.Count -ne $hashes.Count) {
            throw '再梱包した ZIP のファイル数が一致しません。'
        }
        foreach ($name in $hashes.Keys) {
            $entry = $archive.GetEntry($name)
            if ($null -eq $entry) { throw "再梱包した ZIP に $name がありません。" }
            $stream = $entry.Open()
            try {
                if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -ne $hashes[$name]) {
                    throw "再梱包した $name の SHA-256 が一致しません。"
                }
            } finally { $stream.Dispose() }
        }
    } finally { $archive.Dispose() }
}

$tool = Get-Item -LiteralPath $SignToolPath
if ($tool -isnot [IO.FileInfo] -or $tool.Name -ne 'signtool.exe') {
    throw 'Windows SDK の signtool.exe のパスを指定してください。'
}
$signTool = $tool.FullName
$releaseDir = (Resolve-Path -LiteralPath $PSScriptRoot).ProviderPath
$baseName = 'CatJapaneseInput-0.1.0-Windows-x64'
$msiName = "$baseName.msi"
$manifestName = 'SHA256SUMS.txt'
$zipName = "$baseName.zip"
$publicZip = Join-Path $releaseDir $zipName
$workDir = (New-Item -ItemType Directory -Path (Join-Path $releaseDir ('.package-' + [IO.Path]::GetRandomFileName()))).FullName

try {
    $files = Join-Path $workDir 'payload'
    Expand-ReleaseCandidate (Join-Path $releaseDir "$baseName-unsigned.zip") $files
    $manifest = Join-Path $files $manifestName
    $hashes = [Collections.Generic.Dictionary[string, string]]::new([StringComparer]::Ordinal)
    foreach ($line in Get-Content -LiteralPath $manifest) {
        if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { throw "不正なチェックサム行です。$line" }
        $hashes.Add($Matches[2], $Matches[1])
    }
    $msi = Join-Path $files $msiName
    if (!$hashes.ContainsKey($msiName) -or (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ne $hashes[$msiName]) {
        throw '署名前 MSI の SHA-256 が一致しません。'
    }

    if ($SigningService) {
        Write-Host '署名サービスで次の MSI に署名し、署名済み MSI を同じパスに置いてください。'
        Write-Host $msi
        [void] (Read-Host '署名とタイムスタンプの付与が終わったら Enter')
    } else {
        & $signTool sign /sha1 $CertificateThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $msi
        if (!$? -or $LASTEXITCODE -ne 0) { throw "MSI の署名に失敗しました (終了コード $LASTEXITCODE)。" }
    }
    $hashes[$msiName] = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash
    & $signTool verify /pa /v /tw $msi
    if (!$? -or $LASTEXITCODE -ne 0) { throw "署名またはタイムスタンプを確認できませんでした (終了コード $LASTEXITCODE)。" }

    $lines = $hashes.Keys | Sort-Object | ForEach-Object { "$($hashes[$_].ToLowerInvariant())  $_" }
    [IO.File]::WriteAllLines($manifest, [string[]] $lines)
    $hashes.Add($manifestName, (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash)
    $stagedZip = Join-Path $workDir $zipName
    [IO.Compression.ZipFile]::CreateFromDirectory($files, $stagedZip, [IO.Compression.CompressionLevel]::Optimal, $false)
    Assert-ReleaseArchive $stagedZip $hashes
    $zipHash = (Get-FileHash -LiteralPath $stagedZip -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$stagedZip.sha256", "$zipHash  $zipName" + [Environment]::NewLine)

    $lock = [IO.FileStream]::new((Join-Path $releaseDir '.package.lock'), [IO.FileMode]::OpenOrCreate,
        [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096, [IO.FileOptions]::DeleteOnClose)
    try {
        # Withdraw the previous checksum before exposing a new ZIP.
        $oldChecksum = Join-Path $workDir 'previous.sha256'
        if ([IO.File]::Exists("$publicZip.sha256")) { [IO.File]::Move("$publicZip.sha256", $oldChecksum) }
        try {
            [IO.File]::Move($stagedZip, $publicZip, $true)
        } catch {
            if ([IO.File]::Exists($oldChecksum)) { [IO.File]::Move($oldChecksum, "$publicZip.sha256") }
            throw
        }
        [IO.File]::Move("$stagedZip.sha256", "$publicZip.sha256")
    } finally { $lock.Dispose() }

} finally {
    $resolvedWork = (Resolve-Path -LiteralPath $workDir).ProviderPath
    if ([IO.Path]::GetDirectoryName($resolvedWork) -eq $releaseDir -and
        [IO.Path]::GetFileName($resolvedWork) -like '.package-*') {
        Remove-Item -LiteralPath $resolvedWork -Recurse -Force
    }
}

Write-Host '公開用ファイルを作成しました。'
Write-Host $publicZip
Write-Host "$publicZip.sha256"
