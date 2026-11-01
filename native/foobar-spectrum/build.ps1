[CmdletBinding()]
param([switch]$CheckOnly)

# No downloads, no install, no deployment or process launch. The only executable
# build action is a discovered VS MSBuild with an installed v143 x64 C++ toolchain.
$ErrorActionPreference = 'Stop'
$componentRoot = $PSScriptRoot
$sdkRoot = Join-Path $componentRoot 'vendor\foobar2000-SDK-2026-10-01'
$buildRoot = Join-Path $componentRoot 'build'
$emptyUserRoot = (Join-Path $buildRoot 'empty-msbuild-user') + '\'
$buildOutput = (Join-Path $buildRoot 'output') + '\'
$packageRoot = Join-Path $componentRoot 'package'

function Assert-NativePath([string]$Candidate) {
    $absolute = [IO.Path]::GetFullPath($Candidate)
    $prefix = [IO.Path]::GetFullPath($componentRoot).TrimEnd('\') + '\'
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Build output outside the native component tree: $absolute"
    }
    $cursor = $absolute.TrimEnd('\')
    while ($cursor -eq $prefix.TrimEnd('\') -or $cursor.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Build path must not traverse a reparse point: $cursor"
            }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
}
foreach ($directory in @($buildRoot, $emptyUserRoot, $buildOutput, $packageRoot)) { Assert-NativePath $directory }
if (Test-Path -LiteralPath $buildRoot -PathType Container) {
    $links = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    if ($links.Count) { throw 'Build artifacts must not contain reparse points.' }
}
if (Test-Path -LiteralPath $emptyUserRoot) {
    if (-not (Test-Path -LiteralPath $emptyUserRoot -PathType Container) -or
        @(Get-ChildItem -LiteralPath $emptyUserRoot -Force).Count -ne 0) {
        throw 'The isolated MSBuild UserRootDir must be an empty directory; no user.props are permitted.'
    }
}
$libraryProjects = @(
    [ordered]@{ name = 'pfc'; path = (Join-Path $sdkRoot 'pfc\pfc.vcxproj'); configuration = 'Release FB2K' },
    [ordered]@{ name = 'foobar2000_SDK'; path = (Join-Path $sdkRoot 'foobar2000\SDK\foobar2000_SDK.vcxproj'); configuration = 'Release' },
    [ordered]@{ name = 'foobar2000_component_client'; path = (Join-Path $sdkRoot 'foobar2000\foobar2000_component_client\foobar2000_component_client.vcxproj'); configuration = 'Release' }
)
$allowedImports = @('$(VCTargetsPath)\Microsoft.Cpp.Default.props', '$(VCTargetsPath)\Microsoft.Cpp.props',
    '$(VCTargetsPath)\Microsoft.Cpp.targets', '$(UserRootDir)\Microsoft.Cpp.$(Platform).user.props')
$projectAudit = @()
foreach ($project in $libraryProjects) {
    if (-not (Test-Path -LiteralPath $project.path -PathType Leaf)) { continue }
    [xml]$projectXml = Get-Content -LiteralPath $project.path -Raw
    $actions = $projectXml.SelectNodes('//*[local-name()="Exec" or local-name()="Command" or local-name()="PreBuildEvent" or local-name()="PreLinkEvent" or local-name()="PostBuildEvent" or local-name()="CustomBuild" or local-name()="CustomBuildStep" or local-name()="Copy" or local-name()="Delete"]')
    if ($actions.Count) { throw "SDK build actions are not permitted: $($project.path)" }
    foreach ($import in $projectXml.SelectNodes('//*[local-name()="Import"]')) {
        if ($allowedImports -notcontains $import.Project) { throw "Unexpected SDK project import: $($import.Project)" }
    }
    $projectAudit += [ordered]@{ project = $project.path; actions = 'none'; imports = 'SDK C++ defaults plus isolated empty user props only' }
}
$requiredFiles = @('sdk-license.txt', 'pfc\pfc-license.txt', 'pfc\pfc.vcxproj', 'foobar2000\SDK\foobar2000_SDK.vcxproj',
    'foobar2000\foobar2000_component_client\foobar2000_component_client.vcxproj', 'foobar2000\shared\shared-x64.lib')
$missingSdk = @($requiredFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $sdkRoot $_) -PathType Leaf) })
$installRoots = [System.Collections.Generic.List[string]]::new()
$installRoots.Add((Join-Path $componentRoot 'tools\BuildTools2022'))
$vswhereCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft Visual Studio\Installer\vswhere.exe')
)
$vswhere = $vswhereCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ($vswhere) {
    $foundRoots = & $vswhere -all -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    foreach ($candidate in $foundRoots) { if ($candidate) { $installRoots.Add([string]$candidate) } }
}
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    $vsBase = Join-Path $base 'Microsoft Visual Studio'
    if (Test-Path -LiteralPath $vsBase -PathType Container) {
        foreach ($year in Get-ChildItem -LiteralPath $vsBase -Directory) {
            foreach ($edition in Get-ChildItem -LiteralPath $year.FullName -Directory) { $installRoots.Add($edition.FullName) }
        }
    }
}
$selected = $null
foreach ($installRoot in @($installRoots | Select-Object -Unique)) {
    $msbuild = Join-Path $installRoot 'MSBuild\Current\Bin\MSBuild.exe'
    $cppTargets = Join-Path $installRoot 'MSBuild\Microsoft\VC\v170\Microsoft.Cpp.targets'
    $toolsRoot = Join-Path $installRoot 'VC\Tools\MSVC'
    if (-not (Test-Path -LiteralPath $toolsRoot -PathType Container)) { continue }
    $toolVersions = Get-ChildItem -LiteralPath $toolsRoot -Directory | Where-Object { $_.Name -match '^14\.[34]\d\.' } | Sort-Object Name -Descending
    foreach ($toolVersion in $toolVersions) {
        $compiler = Join-Path $toolVersion.FullName 'bin\Hostx64\x64\cl.exe'
        $linker = Join-Path $toolVersion.FullName 'bin\Hostx64\x64\link.exe'
        if ((Test-Path -LiteralPath $msbuild -PathType Leaf) -and (Test-Path -LiteralPath $cppTargets -PathType Leaf) -and
            (Test-Path -LiteralPath $compiler -PathType Leaf) -and (Test-Path -LiteralPath $linker -PathType Leaf)) {
            $selected = [ordered]@{ installRoot = $installRoot; msbuild = $msbuild; cppTargets = $cppTargets;
                compiler = $compiler; linker = $linker; toolVersion = $toolVersion.Name }
            break
        }
    }
    if ($selected) { break }
}
$windowsSdk = $null
$kitsRoots = [System.Collections.Generic.List[string]]::new()
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) { $kitsRoots.Add((Join-Path $base 'Windows Kits\10')) }
foreach ($registryKey in @('HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots')) {
    if (Test-Path -LiteralPath $registryKey) {
        $kits = Get-ItemProperty -LiteralPath $registryKey
        if ($kits.KitsRoot10) { $kitsRoots.Add([string]$kits.KitsRoot10) }
    }
}
foreach ($kitsRoot in @($kitsRoots | Select-Object -Unique)) {
    $includeRoot = Join-Path $kitsRoot 'Include'
    if (-not (Test-Path -LiteralPath $includeRoot -PathType Container)) { continue }
    foreach ($version in Get-ChildItem -LiteralPath $includeRoot -Directory | Sort-Object Name -Descending) {
        $required = @("Include\$($version.Name)\um\Windows.h", "Include\$($version.Name)\ucrt\stdio.h",
            "Lib\$($version.Name)\um\x64\kernel32.lib", "Lib\$($version.Name)\ucrt\x64\ucrt.lib")
        $missing = @($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $kitsRoot $_) -PathType Leaf) })
        if ($missing.Count -eq 0) { $windowsSdk = [ordered]@{ root = $kitsRoot; version = $version.Name }; break }
    }
    if ($windowsSdk) { break }
}
$missing = [System.Collections.Generic.List[string]]::new()
if (-not $selected) { $missing.Add('Visual Studio MSBuild C++ targets and MSVC v143 Hostx64/x64 cl.exe + link.exe') }
if (-not $windowsSdk) { $missing.Add('Windows 10/11 SDK headers and x64 import libraries') }
foreach ($file in $missingSdk) { $missing.Add("SDK file: $file") }
if (-not (Test-Path -LiteralPath (Join-Path $componentRoot 'dsp.hpp') -PathType Leaf)) { $missing.Add('dsp.hpp') }
$report = [ordered]@{
    status = $(if ($missing.Count) { 'unavailable' } else { 'available' })
    checkOnly = [bool]$CheckOnly
    architecture = 'x64'; configuration = 'Release'; toolset = 'v143'; language = 'C++20'
    sdkArchiveSha256 = 'd4c55077336fae81bf8df0259b5b2748fa45ea84132c656ead93eb123cbcdc26'
    sdkRoot = $sdkRoot; toolchain = $selected; windowsSdk = $windowsSdk
    missing = @($missing.ToArray())
    output = Join-Path $componentRoot 'package\foo_still_spectrum.dll'
    deployment = 'none'
    isolation = [ordered]@{ userRootDir = $emptyUserRoot; userRootExists = (Test-Path -LiteralPath $emptyUserRoot -PathType Container); userRootEmpty = $true; importDirectoryBuildProps = $false;
        importDirectoryBuildTargets = $false; solutionDir = $buildRoot + '\'; outDir = $buildOutput;
        intDir = (Join-Path $buildRoot 'obj\<project>') + '\'; projectAudit = $projectAudit }
}
$report | ConvertTo-Json -Depth 6
if ($CheckOnly) { return }
if ($missing.Count) {
    Write-Output 'Native build unavailable. No compiler, SDK or application was installed or started.'
    exit 2
}
New-Item -ItemType Directory -Path $emptyUserRoot -Force | Out-Null
if (@(Get-ChildItem -LiteralPath $emptyUserRoot -Force).Count -ne 0) { throw 'Isolated UserRootDir is no longer empty.' }
$commonArgs = @('/nologo', '/m', '/t:Build', '/p:Platform=x64', '/p:PlatformToolset=v143', '/p:PreferredToolArchitecture=x64',
    '/p:BuildProjectReferences=false', '/p:ImportDirectoryBuildProps=false', '/p:ImportDirectoryBuildTargets=false',
    "/p:UserRootDir=$emptyUserRoot", "/p:SolutionDir=$buildRoot\", "/p:OutDir=$buildOutput",
    "/p:VCTargetsPath=$([IO.Path]::GetDirectoryName($selected.cppTargets))\",
    "/p:VCToolsVersion=$($selected.toolVersion)", "/p:WindowsTargetPlatformVersion=$($windowsSdk.version)",
    '/p:ForceImportBeforeCppDefaultProps=', '/p:ForceImportAfterCppDefaultProps=',
    '/p:ForceImportBeforeCppProps=', '/p:ForceImportAfterCppProps=',
    '/p:ForceImportBeforeCppTargets=', '/p:ForceImportAfterCppTargets=',
    '/p:CustomBeforeMicrosoftCommonProps=', '/p:CustomAfterMicrosoftCommonProps=',
    '/p:CustomBeforeMicrosoftCommonTargets=', '/p:CustomAfterMicrosoftCommonTargets=')
$projects = @($libraryProjects) + @([ordered]@{ name = 'foo_still_spectrum'; path = (Join-Path $componentRoot 'foo_still_spectrum.vcxproj'); configuration = 'Release' })
$buildPlan = @($projects | ForEach-Object {
    $intDir = (Join-Path $buildRoot ('obj\' + $_.name)) + '\'
    Assert-NativePath $intDir
    [ordered]@{ project = $_.path; arguments = @($_.path) + $commonArgs + @("/p:Configuration=$($_.configuration)", "/p:IntDir=$intDir") }
})
$buildPlan | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $buildRoot 'build-plan.json') -Encoding utf8
# Compiler/linker environment overrides can redirect output files. Scope their
# removal to the child build and restore the caller's values even on failure.
$savedOverrides = @{}
foreach ($name in @('CL', '_CL_', 'LINK', '_LINK_')) {
    $savedOverrides[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
$buildExit = 0
try {
    foreach ($invocation in $buildPlan) {
        if (@(Get-ChildItem -LiteralPath $emptyUserRoot -Force).Count -ne 0) { throw 'Isolated UserRootDir is no longer empty.' }
        $buildArgs = $invocation.arguments
        & $selected.msbuild @buildArgs
        if ($LASTEXITCODE -ne 0) { $buildExit = $LASTEXITCODE; break }
    }
} finally {
    foreach ($name in $savedOverrides.Keys) { [Environment]::SetEnvironmentVariable($name, $savedOverrides[$name], 'Process') }
}
if ($buildExit -ne 0) { exit $buildExit }
if (@(Get-ChildItem -LiteralPath $emptyUserRoot -Force).Count -ne 0) { throw 'Isolated UserRootDir was modified during the build.' }
New-Item -ItemType Directory -Path $packageRoot -Force | Out-Null
$packageFiles = @('foo_still_spectrum.dll', 'foobar2000-sdk-license.txt', 'pfc-license.txt', 'COMPONENT-DETAILS.md')
foreach ($file in $packageFiles) {
    Assert-NativePath (Join-Path $packageRoot $file)
    Copy-Item -LiteralPath (Join-Path $buildOutput $file) -Destination (Join-Path $packageRoot $file) -Force
}
if (-not (Test-Path -LiteralPath $report.output -PathType Leaf)) { throw 'MSBuild completed without the expected component DLL.' }
Write-Output "Built $($report.output). No foobar2000 profile or application was modified."
