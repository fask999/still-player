[CmdletBinding()]
param()

# Pure CLI acceptance only: the DSP executable uses synthetic samples, the
# reader's test branch uses fixed protocol data, and Node adapters are fixtures.
# This entry point never builds/loads a foobar DLL or contacts a player/device.
$ErrorActionPreference = 'Stop'
$spectrumTestRoot = $PSScriptRoot
$spectrumProjectRoot = [IO.Path]::GetFullPath((Join-Path $spectrumTestRoot '..\..'))
$spectrumProbeText = & (Join-Path $spectrumTestRoot 'build.ps1') -CheckOnly
$spectrumProbe = ($spectrumProbeText -join [Environment]::NewLine) | ConvertFrom-Json
if ($spectrumProbe.status -ne 'available') {
    throw 'Native test prerequisites unavailable; this entry point does not silently skip or install them.'
}
$spectrumCompiler = $spectrumProbe.toolchain.compiler
$spectrumToolRoot = [IO.Path]::GetFullPath((Join-Path (Split-Path $spectrumCompiler -Parent) '..\..\..'))
$spectrumSdkRoot = $spectrumProbe.windowsSdk.root
$spectrumSdkVersion = $spectrumProbe.windowsSdk.version
$spectrumCompilerDirectory = Split-Path $spectrumCompiler -Parent
$spectrumOldPath = $env:PATH
$spectrumOldInclude = $env:INCLUDE
$spectrumOldLib = $env:LIB
$spectrumOldCl = $env:CL
$spectrumOldClTail = $env:_CL_
$spectrumOldLink = $env:LINK
$spectrumOldLinkTail = $env:_LINK_
$spectrumTestExit = 1
try {
    # Configure this PowerShell process and its test children only. No registry,
    # persistent PATH, user profile, approval or security setting is changed.
    $env:PATH = $spectrumCompilerDirectory + ';' + $spectrumOldPath
    $env:INCLUDE = (Join-Path $spectrumToolRoot 'include') + ';' +
        (Join-Path $spectrumSdkRoot "Include\$spectrumSdkVersion\ucrt") + ';' +
        (Join-Path $spectrumSdkRoot "Include\$spectrumSdkVersion\shared") + ';' +
        (Join-Path $spectrumSdkRoot "Include\$spectrumSdkVersion\um") + ';' +
        (Join-Path $spectrumSdkRoot "Include\$spectrumSdkVersion\winrt")
    $env:LIB = (Join-Path $spectrumToolRoot 'lib\x64') + ';' +
        (Join-Path $spectrumSdkRoot "Lib\$spectrumSdkVersion\ucrt\x64") + ';' +
        (Join-Path $spectrumSdkRoot "Lib\$spectrumSdkVersion\um\x64")
    $env:CL = $null; $env:_CL_ = $null; $env:LINK = $null; $env:_LINK_ = $null
    Push-Location -LiteralPath $spectrumProjectRoot
    try {
        & node --test tests/spectrum-dsp.test.js tests/spectrum-component.test.js tests/spectrum-client.test.js tests/spectrum-reader.test.js
        $spectrumTestExit = $LASTEXITCODE
    } finally { Pop-Location }
} finally {
    $env:PATH = $spectrumOldPath
    $env:INCLUDE = $spectrumOldInclude
    $env:LIB = $spectrumOldLib
    $env:CL = $spectrumOldCl
    $env:_CL_ = $spectrumOldClTail
    $env:LINK = $spectrumOldLink
    $env:_LINK_ = $spectrumOldLinkTail
}
exit $spectrumTestExit
