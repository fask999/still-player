[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$jobBuildRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$jobProjectRoot = [IO.Path]::GetFullPath((Join-Path $jobBuildRoot '..\..'))
$jobProbe = (& (Join-Path $jobProjectRoot 'native\foobar-spectrum\build.ps1') -CheckOnly | Out-String) | ConvertFrom-Json
if ($jobProbe.status -ne 'available') { throw 'Installed MSVC/Windows SDK prerequisites unavailable; nothing was downloaded or run.' }
$jobCompiler = $jobProbe.toolchain.compiler
$jobToolRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path $jobCompiler -Parent) '..\..\..'))
$jobSdkRoot = $jobProbe.windowsSdk.root
$jobSdkVersion = $jobProbe.windowsSdk.version
$jobObjectPath = Join-Path $jobBuildRoot 'launcher.obj'
$jobExePath = Join-Path $jobBuildRoot 'StillBackendLauncher.exe'
$jobSaved = @{}
foreach ($name in @('PATH','INCLUDE','LIB','CL','_CL_','LINK','_LINK_')) { $jobSaved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:PATH = (Split-Path $jobCompiler -Parent) + ';' + $jobSaved.PATH
    $env:INCLUDE = (Join-Path $jobToolRoot 'include') + ';' + (Join-Path $jobSdkRoot "Include\$jobSdkVersion\ucrt") + ';' +
        (Join-Path $jobSdkRoot "Include\$jobSdkVersion\shared") + ';' + (Join-Path $jobSdkRoot "Include\$jobSdkVersion\um")
    $env:LIB = (Join-Path $jobToolRoot 'lib\x64') + ';' + (Join-Path $jobSdkRoot "Lib\$jobSdkVersion\ucrt\x64") + ';' +
        (Join-Path $jobSdkRoot "Lib\$jobSdkVersion\um\x64")
    $env:CL = $null; $env:_CL_ = $null; $env:LINK = $null; $env:_LINK_ = $null
    & $jobCompiler /nologo /std:c++20 /O2 /W4 /WX /EHsc /MT /utf-8 /DUNICODE /D_UNICODE /guard:cf /Brepro "/Fo$jobObjectPath" "/Fe$jobExePath" (Join-Path $jobBuildRoot 'launcher.cpp') /link /DYNAMICBASE /NXCOMPAT /guard:cf bcrypt.lib
    if ($LASTEXITCODE -ne 0) { throw "Owned Job launcher compile failed: $LASTEXITCODE" }
    [ordered]@{status='compiled-not-executed'; compiler=$jobCompiler; windowsSdk=$jobSdkVersion; source='native/backend-job/launcher.cpp';
        output='native/backend-job/StillBackendLauncher.exe'; sha256=(Get-FileHash -LiteralPath $jobExePath -Algorithm SHA256).Hash.ToLowerInvariant()} | ConvertTo-Json
} finally {
    foreach ($name in $jobSaved.Keys) { [Environment]::SetEnvironmentVariable($name, $jobSaved[$name], 'Process') }
}
