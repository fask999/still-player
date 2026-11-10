[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$jobBuildRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$jobProjectRoot = [IO.Path]::GetFullPath((Join-Path $jobBuildRoot '..\..'))
$jobOutputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$jobEvidenceRoot = [IO.Path]::GetFullPath((Join-Path $jobProjectRoot 'review-evidence')).TrimEnd('\') + '\'
if (-not $jobOutputRoot.StartsWith($jobEvidenceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Compilation requires a fresh directory under this workspace review-evidence; no runtime file is overwritten.'
}
function Assert-PlainBuildAncestors([string]$Candidate) {
    $cursor = [IO.Path]::GetFullPath($Candidate)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $item.PSIsContainer) {
                throw 'Compilation paths must have ordinary directory ancestors.'
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\'))
    }
}
Assert-PlainBuildAncestors $jobBuildRoot
Assert-PlainBuildAncestors $jobOutputRoot
if (Test-Path -LiteralPath $jobOutputRoot) { throw 'Compilation output directory must be new; existing artifacts are preserved.' }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($jobOutputRoot)) -PathType Container)) { throw 'Compilation output parent must already exist.' }
$jobSourcePath = Join-Path $jobBuildRoot 'launcher.cpp'
$jobSourceItem = Get-Item -LiteralPath $jobSourcePath -Force
if ($jobSourceItem.PSIsContainer -or ($jobSourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Launcher source must be an ordinary file.' }
$jobSourceHash = (Get-FileHash -LiteralPath $jobSourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$jobProbe = (& (Join-Path $jobProjectRoot 'native\foobar-spectrum\build.ps1') -CheckOnly | Out-String) | ConvertFrom-Json
if ($jobProbe.status -ne 'available') { throw 'Installed MSVC/Windows SDK prerequisites unavailable; nothing was downloaded or run.' }
$jobCompiler = $jobProbe.toolchain.compiler
$jobToolRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path $jobCompiler -Parent) '..\..\..'))
$jobSdkRoot = $jobProbe.windowsSdk.root
$jobSdkVersion = $jobProbe.windowsSdk.version
$null = New-Item -ItemType Directory -Path $jobOutputRoot
Assert-PlainBuildAncestors $jobOutputRoot
$jobObjectPath = Join-Path $jobOutputRoot 'launcher.obj'
$jobExePath = Join-Path $jobOutputRoot 'StillBackendLauncher.exe'
$jobSaved = @{}
foreach ($name in @('PATH','INCLUDE','LIB','CL','_CL_','LINK','_LINK_')) { $jobSaved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:PATH = (Split-Path $jobCompiler -Parent) + ';' + $jobSaved.PATH
    $env:INCLUDE = (Join-Path $jobToolRoot 'include') + ';' + (Join-Path $jobSdkRoot "Include\$jobSdkVersion\ucrt") + ';' +
        (Join-Path $jobSdkRoot "Include\$jobSdkVersion\shared") + ';' + (Join-Path $jobSdkRoot "Include\$jobSdkVersion\um")
    $env:LIB = (Join-Path $jobToolRoot 'lib\x64') + ';' + (Join-Path $jobSdkRoot "Lib\$jobSdkVersion\ucrt\x64") + ';' +
        (Join-Path $jobSdkRoot "Lib\$jobSdkVersion\um\x64")
    $env:CL = $null; $env:_CL_ = $null; $env:LINK = $null; $env:_LINK_ = $null
    & $jobCompiler /nologo /std:c++20 /O2 /W4 /WX /EHsc /MT /utf-8 /DUNICODE /D_UNICODE /guard:cf /Brepro "/Fo$jobObjectPath" "/Fe$jobExePath" $jobSourcePath /link /DYNAMICBASE /NXCOMPAT /guard:cf bcrypt.lib
    if ($LASTEXITCODE -ne 0) { throw "Owned Job launcher compile failed: $LASTEXITCODE" }
    Assert-PlainBuildAncestors $jobOutputRoot
    if ((Get-FileHash -LiteralPath $jobSourcePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $jobSourceHash) { throw 'Launcher source changed during compilation; candidate is not admitted.' }
    [ordered]@{status='compiled-not-executed'; compiler=$jobCompiler; windowsSdk=$jobSdkVersion; source='native/backend-job/launcher.cpp';
        sourceSha256=$jobSourceHash; output=$jobExePath; sha256=(Get-FileHash -LiteralPath $jobExePath -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json
} finally {
    foreach ($name in $jobSaved.Keys) { [Environment]::SetEnvironmentVariable($name, $jobSaved[$name], 'Process') }
}
