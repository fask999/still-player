param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'Existing .NET Framework x64 C# compiler unavailable; no toolchain will be installed.' }
$packageDirectory = Join-Path $PSScriptRoot 'package'
[System.IO.Directory]::CreateDirectory($packageDirectory) | Out-Null
$readerExecutable = Join-Path $packageDirectory 'StillSpectrumReader.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ /warnaserror+ /reference:System.Web.Extensions.dll "/out:$readerExecutable" (Join-Path $PSScriptRoot 'SpectrumPipeReader.cs')
if ($LASTEXITCODE -ne 0) { throw "Reader compile failed: $LASTEXITCODE" }
if ($SelfTest) {
    # Early-return fixture mode: no named pipe, process inspection or audio APIs.
    & $readerExecutable --protocol-self-test
    if ($LASTEXITCODE -ne 0) { throw "Reader fixture self-test failed: $LASTEXITCODE" }
}
