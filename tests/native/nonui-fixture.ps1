$ErrorActionPreference = 'Stop'
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskDirectory = Join-Path $taskRoot 'tools\release-ci\nonui-fixture'
$prepared = Get-Content -LiteralPath (Join-Path $taskDirectory 'prepared.json') -Raw | ConvertFrom-Json
$recordPath = Join-Path $taskDirectory 'execution.json'
if (Test-Path -LiteralPath $recordPath) { throw 'Preserve the existing execution; do not rerun this fixture batch' }
if ((Get-FileHash -LiteralPath $prepared.exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $prepared.fixtureExeSha256) { throw 'Fixture executable changed' }
$targets = Join-Path $taskDirectory 'targets'
New-Item -ItemType Directory -Path $targets | Out-Null
$unicodeTarget = Join-Path $targets '中文 路径\STILL With Space'
$existing = Join-Path $targets 'existing-nonempty'
New-Item -ItemType Directory -Path $existing | Out-Null
[IO.File]::WriteAllText((Join-Path $existing 'KEEP.txt'), 'KEEP-EXISTING')
$cases = @(
  @{ Name='default-silent'; Arguments='/S'; Expected=0; Target=$prepared.defaultTarget },
  @{ Name='unicode-spaces-final-D'; Arguments=('/S /D=' + $unicodeTarget); Expected=0; Target=$unicodeTarget },
  @{ Name='registered-conflict'; Arguments=('/S /D=' + (Join-Path $targets 'conflict')); Expected=22; Conflict='1' },
  @{ Name='unknown-flag'; Arguments='/S /UNKNOWN'; Expected=10 },
  @{ Name='lowercase-s-no-UI'; Arguments='/s'; Expected=10 },
  @{ Name='lowercase-D'; Arguments=('/S /d=' + (Join-Path $targets 'lower-d')); Expected=10 },
  @{ Name='repeated-S'; Arguments='/S /S'; Expected=10 },
  @{ Name='misplaced-S-after-D'; Arguments=('/D=' + (Join-Path $targets 'misplaced') + ' /S'); Expected=10 },
  @{ Name='quoted-D-refused'; Arguments=('/S /D="' + (Join-Path $targets 'quoted') + '"'); Expected=10 },
  @{ Name='relative-D'; Arguments='/S /D=relative-path'; Expected=10 },
  @{ Name='empty-D'; Arguments='/S /D='; Expected=10 },
  @{ Name='flag-after-D'; Arguments=('/S /D=' + (Join-Path $targets 'after') + ' /BAD'); Expected=10 },
  @{ Name='dash-flag-after-D'; Arguments=('/S /D=' + (Join-Path $targets 'after-dash') + ' --bad'); Expected=10 },
  @{ Name='system-directory'; Arguments=('/S /D=' + (Join-Path $env:WINDIR 'Temp\STILL-MUST-NOT-CREATE')); Expected=20 },
  @{ Name='drive-root'; Arguments='/S /D=D:\'; Expected=20 },
  @{ Name='data-root-equal'; Arguments=('/S /D=' + (Join-Path $taskDirectory 'data-root')); Expected=20 },
  @{ Name='nonempty-kept'; Arguments=('/S /D=' + $existing); Expected=20 },
  @{ Name='copy-new-conflict'; Arguments=('/S /D=' + (Join-Path $targets 'copy-conflict')); Expected=23; Collision='1' },
  @{ Name='postcondition-refuses-fake-reg-mismatch'; Arguments=('/S /D=' + (Join-Path $targets 'bad-postcondition')); Expected=25; Tamper='1' },
  @{ Name='overlong-command'; Arguments=('/S /D=D:\' + ('a' * 1100)); Expected=10 }
)
$results = @()
$startedAt = [DateTime]::UtcNow.ToString('o')
foreach ($case in $cases) {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $prepared.exe
  # Exact raw NSIS grammar: /D is last and its path is not quoted, even with spaces.
  $start.Arguments = $case.Arguments
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.WorkingDirectory = $taskDirectory
  foreach ($key in @('STILL_NCI_CONFLICT','STILL_NCI_TAMPER','STILL_NCI_COLLISION')) { $start.Environment.Remove($key) | Out-Null }
  if ($case.Conflict) { $start.Environment['STILL_NCI_CONFLICT'] = $case.Conflict }
  if ($case.Tamper) { $start.Environment['STILL_NCI_TAMPER'] = $case.Tamper }
  if ($case.Collision) { $start.Environment['STILL_NCI_COLLISION'] = $case.Collision }
  try { $process = [Diagnostics.Process]::Start($start) }
  catch { $results += @{ Name=$case.Name; Blocked=$true; Error=$_.Exception.Message; Passed=$false }; break }
  if (-not $process.WaitForExit(15000)) {
    $process.Kill()
    $results += @{ Name=$case.Name; Timeout=$true; Passed=$false }
    break
  }
  $actual = $process.ExitCode
  $entry = [ordered]@{ Name=$case.Name; Arguments=$case.Arguments; Expected=$case.Expected; Actual=$actual; Passed=($actual -eq $case.Expected); UiCanaryReached=($actual -eq 98) }
  if ($case.Expected -eq 0) {
    $receipt = [IO.File]::ReadAllText((Join-Path $case.Target 'INSTALL-RECEIPT.ini'),[Text.Encoding]::Unicode)
    $entry['ReceiptExactPath'] = $receipt.Contains('InstallDirectory=' + $case.Target + "`r`n")
    $entry['PayloadExact'] = [IO.File]::ReadAllText((Join-Path $case.Target 'payload.txt')) -eq 'ISOLATED NATIVE FIXTURE PAYLOAD'
    $entry['Passed'] = $entry['Passed'] -and $entry['ReceiptExactPath'] -and $entry['PayloadExact']
  }
  $results += $entry
}
$record = [ordered]@{ StartedAt=$startedAt; CompletedAt=[DateTime]::UtcNow.ToString('o'); Prepared=$prepared; Invocation='ProcessStartInfo.FileName + exact Arguments; UseShellExecute=false; no shell or desktop'; Results=$results; Passed=@($results | Where-Object Passed).Count; Failed=@($results | Where-Object { -not $_.Passed }).Count; ExistingFilePreserved=([IO.File]::ReadAllText((Join-Path $existing 'KEEP.txt')) -eq 'KEEP-EXISTING'); Scope='Only isolated default/explicit fixture targets; fake registration reads; no public Setup or uninstaller, registry, shortcuts or UI APIs' }
$record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $recordPath -Encoding utf8
$record | ConvertTo-Json -Depth 5
if ($record.Failed -or -not $record.ExistingFilePreserved -or $results.Count -ne $cases.Count) { exit 1 }
