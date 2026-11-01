[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$fixtureRoot = $PSScriptRoot
$nativeRoot = Split-Path $fixtureRoot -Parent
$repoRoot = [IO.Path]::GetFullPath((Join-Path $nativeRoot '..\..'))
$evidence = Join-Path $repoRoot 'review-evidence\spectrum-20261101\real-pipe'
$tools = Join-Path $nativeRoot 'tools\BuildTools2022'
$msbuild = Join-Path $tools 'MSBuild\Current\Bin\MSBuild.exe'
$cpp = (Join-Path $tools 'MSBuild\Microsoft\VC\v170') + '\'
$dumpbin = Join-Path $tools 'VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\dumpbin.exe'
$buildRoot = Join-Path $fixtureRoot 'build'
$emptyUser = (Join-Path $buildRoot 'empty-msbuild-user') + '\'
foreach ($required in @($msbuild, $dumpbin)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Required installed tool unavailable: $required" } }
if (Test-Path -LiteralPath $buildRoot) {
    if (@(Get-ChildItem -LiteralPath $buildRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Fixture build tree must not contain links.' }
}
foreach ($directory in @($fixtureRoot, $evidence)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
& node (Join-Path $fixtureRoot 'extract.js') --generate
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Path $emptyUser -Force | Out-Null
if (@(Get-ChildItem -LiteralPath $emptyUser -Force).Count) { throw 'Fixture UserRootDir is not empty.' }
$buildArgs = @((Join-Path $fixtureRoot 'pipe-fixture.vcxproj'), '/nologo', '/m', '/t:Build', '/p:Configuration=Release',
    '/p:Platform=x64', '/p:PlatformToolset=v143', '/p:PreferredToolArchitecture=x64', '/p:VCToolsVersion=14.44.35207',
    '/p:WindowsTargetPlatformVersion=10.0.26100.0', "/p:VCTargetsPath=$cpp", "/p:UserRootDir=$emptyUser",
    "/p:SolutionDir=$buildRoot\", "/p:OutDir=$buildRoot\bin\", "/p:IntDir=$buildRoot\obj\",
    '/p:ImportDirectoryBuildProps=false', '/p:ImportDirectoryBuildTargets=false', '/p:BuildProjectReferences=false',
    '/p:ForceImportBeforeCppDefaultProps=', '/p:ForceImportAfterCppDefaultProps=', '/p:ForceImportBeforeCppProps=',
    '/p:ForceImportAfterCppProps=', '/p:ForceImportBeforeCppTargets=', '/p:ForceImportAfterCppTargets=',
    '/p:CustomBeforeMicrosoftCommonProps=', '/p:CustomAfterMicrosoftCommonProps=',
    '/p:CustomBeforeMicrosoftCommonTargets=', '/p:CustomAfterMicrosoftCommonTargets=')
[ordered]@{ executable = $msbuild; arguments = $buildArgs; compiledOnly = $true; fixtureExecution = $false } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidence 'build-plan.json') -Encoding utf8
$saved = @{}
foreach ($name in @('CL', '_CL_', 'LINK', '_LINK_')) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process'); [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
try { & $msbuild @buildArgs *> (Join-Path $evidence 'fixture-build.log'); $buildExit = $LASTEXITCODE }
finally { foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } }
Get-Content -LiteralPath (Join-Path $evidence 'fixture-build.log') -Tail 15
if ($buildExit -ne 0) { exit $buildExit }
$exe = Join-Path $buildRoot 'bin\StillSpectrumPipeFixture.exe'
foreach ($mode in @('headers', 'exports', 'dependents')) {
    & $dumpbin /nologo "/$mode" $exe > (Join-Path $evidence "fixture-pe-$mode.txt")
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
$headers = Get-Content -LiteralPath (Join-Path $evidence 'fixture-pe-headers.txt') -Raw
$dependencies = Get-Content -LiteralPath (Join-Path $evidence 'fixture-pe-dependents.txt') -Raw
if ($headers -notmatch '8664 machine \(x64\)' -or $headers -notmatch 'subsystem \(Windows CUI\)') { throw 'Expected x64 console fixture PE.' }
$dependencyNames = @($dependencies -split '\r?\n' | Where-Object { $_ -match '^\s+[^\\/:]+\.dll\s*$' } | ForEach-Object { $_.Trim() })
foreach ($dependency in $dependencyNames) {
    if ($dependency -notmatch '(?i)^(?:KERNEL32|ADVAPI32|MSVCP140|VCRUNTIME140|VCRUNTIME140_1|api-ms-win-crt-[a-z0-9-]+)\.dll$') {
        throw "Unexpected host/media/GUI dependency: $dependency"
    }
}
$repoRelative = { param($file) [IO.Path]::GetRelativePath($repoRoot, $file).Replace('\', '/') }
$artifactFiles = @($exe, (Join-Path $fixtureRoot 'generated\fixture.cpp'), (Join-Path $fixtureRoot 'generated\extraction-manifest.json'),
    (Join-Path $fixtureRoot 'extract.js'), (Join-Path $fixtureRoot 'fixture-template.cpp'), (Join-Path $fixtureRoot 'pipe-fixture.vcxproj'),
    (Join-Path $fixtureRoot 'build-fixture.ps1'), (Join-Path $fixtureRoot 'accepted-inputs.json'), (Join-Path $repoRoot 'tests\spectrum-pipe.integration.test.js'))
$artifacts = @($artifactFiles | ForEach-Object { [ordered]@{ path = (& $repoRelative $_); bytes = (Get-Item -LiteralPath $_).Length; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() } })
[ordered]@{ schemaVersion = 1; fixtureOnly = $true; compiled = $true; executed = $false; artifacts = $artifacts } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $fixtureRoot 'compiled-manifest.json') -Encoding utf8
Copy-Item -LiteralPath (Join-Path $fixtureRoot 'compiled-manifest.json') -Destination (Join-Path $evidence 'compiled-manifest.json') -Force
Write-Output "Compiled and statically inspected $exe. Fixture and production reader were NOT executed."
