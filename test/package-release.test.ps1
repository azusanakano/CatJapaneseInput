#Requires -Version 7.0
param(
    [string] $PackageScript = (Join-Path $PSScriptRoot '..\dist\CatJapaneseInput-0.1.0\package-release.ps1')
)

$ErrorActionPreference = 'Stop'
$packageScript = (Get-Item -LiteralPath $PackageScript).FullName
$root = (New-Item -ItemType Directory -Path (Join-Path ([IO.Path]::GetTempPath()) ('catj-release-test-' + [IO.Path]::GetRandomFileName()))).FullName
$baseName = 'CatJapaneseInput-0.1.0-Windows-x64'
$msiName = "$baseName.msi"
$unsignedName = "$baseName-unsigned.zip"
$firstThumbprint = 'A' * 40
$secondThumbprint = 'B' * 40
$warningThumbprint = 'C' * 40
$originalMsi = 'Unsigned fixture MSI'
$contents = @{
    $msiName = $originalMsi
    'README-ja.txt' = 'User instructions'
    'licenses/notice.txt' = 'License notice'
    'qt-source/qtbase.tar.xz' = 'Qt source archive'
}

function New-ReleaseFixture([string] $name) {
    $dir = [IO.Directory]::CreateDirectory((Join-Path $root "$name test")).FullName
    Copy-Item -LiteralPath $packageScript -Destination (Join-Path $dir 'package-release.ps1')
    Copy-Item -LiteralPath $fixtureZip, "$fixtureZip.sha256" -Destination $dir
    return $dir
}

function Invoke-TestRelease([string] $dir, [string] $tool, [string] $thumbprint) {
    $output = & (Join-Path $PSHOME 'pwsh.exe') -NoProfile -NonInteractive -File $runner (Join-Path $dir 'package-release.ps1') $tool $thumbprint 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
}

function Assert-Release([string] $dir, [string] $thumbprint) {
    $zipPath = Join-Path $dir "$baseName.zip"
    $archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
    try {
        foreach ($name in $contents.Keys) {
            $entry = $archive.GetEntry($name)
            if ($null -eq $entry) { throw "Missing from the release ZIP: $name" }
            $reader = [IO.StreamReader]::new($entry.Open())
            try { $actual = $reader.ReadToEnd() } finally { $reader.Dispose() }
            $expected = if ($name -eq $msiName) { "$originalMsi|$thumbprint" } else { $contents[$name] }
            if ($actual -cne $expected) { throw "Wrong bytes in the release ZIP: $name" }
        }
        $msiBytes = $archive.GetEntry($msiName).Open()
        try { $signedHash = (Get-FileHash -InputStream $msiBytes -Algorithm SHA256).Hash } finally { $msiBytes.Dispose() }
        $reader = [IO.StreamReader]::new($archive.GetEntry('SHA256SUMS.txt').Open())
        try {
            if ($reader.ReadToEnd() -split '\r?\n' -notcontains "$signedHash  $msiName") {
                throw 'The manifest does not name the signed MSI hash.'
            }
        } finally { $reader.Dispose() }
    } finally { $archive.Dispose() }
    $zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
    if (([IO.File]::ReadAllText("$zipPath.sha256")).TrimEnd() -ne "$zipHash  $baseName.zip") {
        throw 'The sidecar does not match the release ZIP.'
    }
}

try {
    $runner = Join-Path $root 'run-package.ps1'
    [IO.File]::WriteAllText($runner, @'
param([string] $ScriptPath, [string] $Tool, [string] $Thumbprint)
$LASTEXITCODE = 0
& $ScriptPath -SignToolPath $Tool -CertificateThumbprint $Thumbprint -TimestampUrl 'https://example.invalid/'
if (!$?) { exit 1 }
'@)
    $payload = Join-Path $root 'unsigned'
    $manifest = foreach ($name in $contents.Keys) {
        $path = Join-Path $payload $name
        [void] [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
        [IO.File]::WriteAllText($path, $contents[$name])
        '{0}  {1}' -f (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(), $name
    }
    [IO.File]::WriteAllLines((Join-Path $payload 'SHA256SUMS.txt'), [string[]] $manifest)
    $fixtureZip = Join-Path $root $unsignedName
    [IO.Compression.ZipFile]::CreateFromDirectory($payload, $fixtureZip)
    $fixtureZipHash = (Get-FileHash -LiteralPath $fixtureZip -Algorithm SHA256).Hash
    [IO.File]::WriteAllText("$fixtureZip.sha256", "$fixtureZipHash  $unsignedName")

    # A stand-in for the external signer. It only accepts the dummy MSI above.
    $signTool = Join-Path $root 'signtool.exe'
    $testToolSource = Join-Path $root 'FixtureSignTool.cs'
    [IO.File]::WriteAllText($testToolSource, @'
using System;
using System.IO;
class FixtureSignTool {
    static int Main(string[] args) {
        string path = args[args.Length - 1];
        try {
            return Run(args, path);
        } catch (Exception error) {
            Console.Error.WriteLine(error.GetType().Name + " for fixture path length " + path.Length);
            return 1;
        }
    }
    static int Run(string[] args, string path) {
        string text = File.ReadAllText(path);
        const string original = "Unsigned fixture MSI";
        if (!text.StartsWith(original, StringComparison.Ordinal)) return 1;
        if (args[0] == "sign") {
            File.WriteAllText(path, original + "|" + args[2]);
            return 0;
        }
        if (args[0] != "verify" || args[1] != "/pa" || args[3] != "/tw" || text == original) return 1;
        return text.EndsWith(new string('C', 40), StringComparison.Ordinal) ? 2 : 0;
    }
}
'@)
    $compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    & $compiler /nologo /target:exe "/out:$signTool" $testToolSource
    if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the test signer.' }

    $cases = [ordered] @{
        'Stops when SignTool cannot be started, even after exit code zero' = {
            $dir = New-ReleaseFixture 'missing-tool'
            $badTool = Join-Path $dir 'signtool.exe'
            foreach ($exists in @($false, $true)) {
                if ($exists) { [IO.File]::WriteAllText($badTool, 'Not an executable') }
                $stopped = $false
                try { Invoke-TestRelease $dir $badTool $firstThumbprint 2>$null } catch { $stopped = $true }
                if (!$stopped -or (Test-Path -LiteralPath (Join-Path $dir "$baseName.zip"))) {
                    throw 'An unverified package was allowed through.'
                }
            }
        }
        'Restores licenses and Qt source even if an old extraction contains only the MSI' = {
            $dir = New-ReleaseFixture 'partial-extraction'
            $oldFiles = [IO.Directory]::CreateDirectory((Join-Path $dir $baseName)).FullName
            [IO.File]::WriteAllText((Join-Path $oldFiles $msiName), $originalMsi)
            Invoke-TestRelease $dir $signTool $firstThumbprint
            Assert-Release $dir $firstThumbprint
        }
        'Replaces the old ZIP and checksum on a successful rerun' = {
            $dir = New-ReleaseFixture 'rerun'
            Invoke-TestRelease $dir $signTool $firstThumbprint
            Assert-Release $dir $firstThumbprint
            Invoke-TestRelease $dir $signTool $secondThumbprint 2>$null
            Assert-Release $dir $secondThumbprint
        }
        'Leaves the last valid output in place when signature verification warns' = {
            $dir = New-ReleaseFixture 'verify-warning'
            Invoke-TestRelease $dir $signTool $firstThumbprint
            $stopped = $false
            try { Invoke-TestRelease $dir $signTool $warningThumbprint 2>$null } catch { $stopped = $true }
            if (!$stopped) { throw 'A SignTool warning was accepted.' }
            Assert-Release $dir $firstThumbprint
        }
        'Restores the old checksum when Windows refuses to replace the ZIP' = {
            $dir = New-ReleaseFixture 'locked-zip'
            Invoke-TestRelease $dir $signTool $firstThumbprint
            $oldZip = [IO.File]::OpenRead((Join-Path $dir "$baseName.zip"))
            $stopped = $false
            try { Invoke-TestRelease $dir $signTool $secondThumbprint 2>$null } catch { $stopped = $true } finally { $oldZip.Dispose() }
            if (!$stopped) { throw 'A failed ZIP replacement was accepted.' }
            Assert-Release $dir $firstThumbprint
        }
    }
    $failures = foreach ($case in $cases.GetEnumerator()) {
        try {
            & $case.Value
            Write-Host "PASS $($case.Key)"
        } catch {
            Write-Host "FAIL $($case.Key)"
            $_.Exception.Message
        }
    }
    if ($failures) { throw ($failures -join [Environment]::NewLine) }
} finally {
    $resolvedRoot = (Resolve-Path -LiteralPath $root).ProviderPath
    $tempParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedRoot) -like 'catj-release-test-*') {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
