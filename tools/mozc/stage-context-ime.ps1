[CmdletBinding()]
param(
    [Parameter(Mandatory)][string] $MozcCheckout,
    [Parameter(Mandatory)][string] $ModelPath
)

$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath $MozcCheckout).Path
$model = Get-Item -LiteralPath $ModelPath
if ($model.PSIsContainer -or $model.Length -ne 1072752) {
    throw 'Pass a binary model produced by tools/mozc/export-model.mjs.'
}
$head = git -C $checkout rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne 'a4541df29db443b49f81cf54665873b68fde9efa') {
    throw 'The checkout must be at the pinned Mozc commit.'
}

function Apply-CatjPatch([string] $Name) {
    $patch = Join-Path $PSScriptRoot $Name
    git -C $checkout apply --check --reverse $patch 2>$null
    if ($LASTEXITCODE -eq 0) { return }
    git -C $checkout apply --check --whitespace=error $patch
    if ($LASTEXITCODE -ne 0) { throw "Patch preflight failed: $Name" }
    git -C $checkout apply --whitespace=error $patch
    if ($LASTEXITCODE -ne 0) { throw "Patch did not apply: $Name" }
}

Apply-CatjPatch 'catj-brand.patch'
Apply-CatjPatch 'catj-context-package.patch'
Apply-CatjPatch 'catj-context-licenses.patch'
Apply-CatjPatch 'catj-context-server.patch'
Apply-CatjPatch 'catj-context-tsf.patch'

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../native/mozc')).Path
$target = Join-Path $checkout 'src/catj'
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($file in @('BUILD.bazel', 'catj_context.h', 'catj_context.cc', 'catj_context_test.cc',
                    'catj_context_model.h', 'catj_context_model.cc', 'catj_context_model_test.cc',
                    'catj_packaged_model.h', 'catj_packaged_model.cc')) {
    Copy-Item -LiteralPath (Join-Path $source $file) -Destination (Join-Path $target $file) -Force
}
$utf8proc = 'third_party/utf8proc'
$vendor = Join-Path $target $utf8proc
New-Item -ItemType Directory -Path $vendor -Force | Out-Null
foreach ($file in @('utf8proc.c', 'utf8proc.h', 'utf8proc_data.c', 'LICENSE.md')) {
    Copy-Item -LiteralPath (Join-Path $source "$utf8proc/$file") -Destination (Join-Path $vendor $file) -Force
}
Copy-Item -LiteralPath $model.FullName -Destination (Join-Path $target 'catj-model.bin') -Force
