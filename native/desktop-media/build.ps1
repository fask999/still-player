[CmdletBinding()]
param([switch]$CheckOnly, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$mediaRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$mediaBin = Join-Path $mediaRoot 'bin'
$mediaFramework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$mediaCompiler = Join-Path $mediaFramework 'csc.exe'
$mediaRuntime = Join-Path $mediaFramework 'System.Runtime.WindowsRuntime.dll'
$mediaGac = Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL'
$mediaMetadataRoots = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\UnionMetadata'),
    (Join-Path $env:ProgramFiles 'Windows Kits\10\UnionMetadata')
)
$mediaMetadata = $null
foreach ($root in $mediaMetadataRoots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    foreach ($version in Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -match '^10\.\d+\.\d+\.\d+$' } | Sort-Object Name -Descending) {
        $candidate = Join-Path $version.FullName 'Windows.winmd'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $mediaMetadata = $candidate; break }
    }
    if ($mediaMetadata) { break }
}
$mediaRefs = @($mediaRuntime)
foreach ($name in @('System.Runtime', 'System.Runtime.InteropServices.WindowsRuntime')) {
    $directory = Join-Path $mediaGac $name
    $reference = if (Test-Path -LiteralPath $directory) { Get-ChildItem -LiteralPath $directory -Recurse -Filter ($name + '.dll') | Sort-Object FullName | Select-Object -First 1 } else { $null }
    if ($reference) { $mediaRefs += $reference.FullName } else { throw "Installed .NET Framework reference missing: $name" }
}
foreach ($file in @($mediaCompiler, $mediaRuntime, (Join-Path $mediaRoot 'StillMediaControls.cs'), (Join-Path $mediaRoot 'LICENSE.txt'), (Join-Path $mediaRoot 'NOTICE.txt'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Installed compiler or local build source unavailable; no download was attempted.' }
}
if (-not $mediaMetadata) { throw 'Installed Windows SDK Windows.winmd unavailable; no download was attempted.' }
if ($CheckOnly) {
    [ordered]@{ status = 'available'; compiler = $mediaCompiler; metadata = $mediaMetadata; references = $mediaRefs; architecture = 'x64'; downloads = 0; smtcRegistered = $false } | ConvertTo-Json -Depth 4
    return
}
# This script writes only its own subtree and refuses link/reparse traversal.
$mediaPrefix = $mediaRoot.TrimEnd('\') + '\'
$mediaCursor = $mediaRoot
while ($mediaCursor) {
    if ((Get-Item -LiteralPath $mediaCursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Build path traverses a reparse point.' }
    $mediaCursor = [IO.Path]::GetDirectoryName($mediaCursor)
}
if (-not ([IO.Path]::GetFullPath($mediaBin)).StartsWith($mediaPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output escaped native media tree.' }
if (Test-Path -LiteralPath $mediaBin) {
    if ((Get-Item -LiteralPath $mediaBin -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime directory cannot be a reparse point.' }
    foreach ($entry in Get-ChildItem -LiteralPath $mediaBin -Force) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.PSIsContainer -or $entry.Name -notin @('StillMediaControls.exe', 'LICENSE.txt', 'NOTICE.txt', 'runtime-manifest.json')) { throw 'Unexpected entry in the strict runtime directory.' }
    }
}
New-Item -ItemType Directory -Path $mediaBin -Force | Out-Null
$mediaExe = Join-Path $mediaBin 'StillMediaControls.exe'
$mediaArguments = @('/nologo', '/utf8output', '/target:exe', '/platform:x64', '/optimize+', '/warn:4', '/warnaserror+', '/checked+', "/out:$mediaExe", '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Windows.Forms.dll', "/reference:$mediaMetadata")
foreach ($reference in $mediaRefs) { $mediaArguments += "/reference:$reference" }
& $mediaCompiler @mediaArguments (Join-Path $mediaRoot 'StillMediaControls.cs')
if ($LASTEXITCODE -ne 0) { throw "Native media C# compilation failed ($LASTEXITCODE)." }
foreach ($name in @('LICENSE.txt', 'NOTICE.txt')) { Copy-Item -LiteralPath (Join-Path $mediaRoot $name) -Destination (Join-Path $mediaBin $name) -Force }
$mediaFiles = @(foreach ($name in @('StillMediaControls.exe', 'LICENSE.txt', 'NOTICE.txt')) {
    $file = Join-Path $mediaBin $name
    [ordered]@{ path = $name; bytes = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
})
$mediaManifest = [ordered]@{ schemaVersion = 1; kind = 'still-desktop-media'; architecture = 'x64'; files = $mediaFiles }
[IO.File]::WriteAllText((Join-Path $mediaBin 'runtime-manifest.json'), (($mediaManifest | ConvertTo-Json -Depth 5) + "`n"), (New-Object Text.UTF8Encoding($false)))
if ($SelfTest) { & $mediaExe --self-test; if ($LASTEXITCODE -ne 0) { throw 'Native media pure protocol self-test failed.' } }
[ordered]@{ status = 'compiled'; output = $mediaExe; files = $mediaFiles; selfTest = [bool]$SelfTest; smtcRegistered = $false; downloads = 0 } | ConvertTo-Json -Depth 5
