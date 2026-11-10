[CmdletBinding()]
param([switch]$CheckOnly, [switch]$BuildRuntime, [string]$FixtureOutputDirectory)
$ErrorActionPreference = 'Stop'
$cueSourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$cueProjectRoot = [IO.Path]::GetFullPath((Join-Path $cueSourceRoot '..\..'))
$cueCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$cueSource = Join-Path $cueSourceRoot 'StillCueReadLease.cs'
$cueNotice = Join-Path $cueSourceRoot 'NOTICE.txt'
foreach ($cueInput in @($cueCompiler, $cueSource, $cueNotice)) {
    if (-not (Test-Path -LiteralPath $cueInput -PathType Leaf)) { throw 'Installed compiler or local source unavailable; no download attempted.' }
}
if ($CheckOnly -or (-not $BuildRuntime -and -not $FixtureOutputDirectory)) {
    [ordered]@{status = 'available'; compiler = $cueCompiler; architecture = 'x64'; framework = '4.8'; source = $cueSource; downloads = 0; runtimeApproved = $false} | ConvertTo-Json
    return
}
if ($BuildRuntime -and $FixtureOutputDirectory) { throw 'Select one output scope.' }
$cueBin = if ($BuildRuntime) { Join-Path $cueSourceRoot 'bin' } else { [IO.Path]::GetFullPath($FixtureOutputDirectory) }
if (-not $BuildRuntime) {
    $cueEvidence = [IO.Path]::GetFullPath((Join-Path $cueProjectRoot 'review-evidence\20261108-public-release\cue-read-lease')) + '\'
    if (-not $cueBin.StartsWith($cueEvidence, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture output escaped its ignored evidence tree.' }
}
foreach ($cueTarget in @($cueSourceRoot, $cueBin)) {
    $cueCursor = $cueTarget
    while ($cueCursor) {
        if (Test-Path -LiteralPath $cueCursor) {
            if ((Get-Item -LiteralPath $cueCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Build paths cannot traverse links/reparse points.' }
        }
        $cueCursor = [IO.Path]::GetDirectoryName($cueCursor)
    }
}
if (Test-Path -LiteralPath $cueBin) {
    # Never let csc, Copy-Item or WriteAllText open an existing destination;
    # even a legitimate filename could be a hard link to another user's file.
    if (@(Get-ChildItem -LiteralPath $cueBin -Force).Count -ne 0) { throw 'Runtime output must be freshly empty. Existing artifacts were retained; no compiler or copy was started.' }
}
New-Item -ItemType Directory -Path $cueBin -Force | Out-Null
$cueExe = Join-Path $cueBin 'StillCueReadLease.exe'
& $cueCompiler /nologo /utf8output /target:exe /platform:x64 /optimize+ /warn:4 /warnaserror+ /checked+ ("/out:$cueExe") $cueSource
if ($LASTEXITCODE -ne 0) { throw "Read-only holder compile failed ($LASTEXITCODE)." }
Copy-Item -LiteralPath $cueNotice -Destination (Join-Path $cueBin 'NOTICE.txt') -Force
function Get-CueBuildHash([string]$LiteralFile) {
    $cueHash = [Security.Cryptography.SHA256]::Create()
    $cueStream = [IO.File]::OpenRead($LiteralFile)
    try { return [BitConverter]::ToString($cueHash.ComputeHash($cueStream)).Replace('-', '').ToLowerInvariant() }
    finally { $cueStream.Dispose(); $cueHash.Dispose() }
}
$cueFiles = @(foreach ($cueName in @('StillCueReadLease.exe', 'NOTICE.txt')) {
    $cueFile = Join-Path $cueBin $cueName
    [ordered]@{path = $cueName; bytes = (Get-Item -LiteralPath $cueFile).Length; sha256 = (Get-CueBuildHash $cueFile)}
})
$cueManifest = [ordered]@{schemaVersion = 1; kind = 'still-cue-read-lease'; architecture = 'x64'; files = $cueFiles}
[IO.File]::WriteAllText((Join-Path $cueBin 'runtime-manifest.json'), (($cueManifest | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
[ordered]@{status = 'compiled-candidate'; output = $cueExe; files = $cueFiles; downloads = 0; runtimeApproved = $false; sourceModified = $false} | ConvertTo-Json -Depth 5
