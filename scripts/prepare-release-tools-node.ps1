$ErrorActionPreference = 'Stop'
if ($env:GH_TOKEN) { throw 'A release-write token must not enter Node bootstrap' }
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$recipe = Get-Content -LiteralPath (Join-Path $taskRoot 'installer\release-tools.json') -Raw | ConvertFrom-Json
if ($recipe.schemaVersion -ne 1 -or $recipe.node.version -ne '24.22.1' -or $recipe.node.url -ne 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip' -or $recipe.node.prefix -ne 'node-v24.22.1-win-x64/' -or $recipe.node.bytes -ne 37748064 -or $recipe.node.sha256 -ne 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5') { throw 'Unreviewed portable Node recipe' }
$stage = Join-Path $taskRoot 'tools\release-ci\node'
$archive = Join-Path $taskRoot 'tools\release-ci\node.zip'
foreach ($target in @($stage,$archive)) {
  for ($cursor = $target; $cursor; $cursor = [IO.Path]::GetDirectoryName($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Node bootstrap path contains a reparse point' }
    }
  }
  if (Test-Path -LiteralPath $target) { throw 'Node bootstrap output already exists; refusing overwrite' }
}
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($archive)) -Force | Out-Null
Invoke-WebRequest -Uri $recipe.node.url -OutFile $archive -MaximumRedirection 0 -TimeoutSec 120
if ((Get-Item -LiteralPath $archive).Length -ne $recipe.node.bytes -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $recipe.node.sha256) { throw 'Portable Node archive hash/size differs' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $total = 0L
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if (-not $name.StartsWith($recipe.node.prefix,[StringComparison]::Ordinal)) { throw 'Node ZIP root differs' }
    $relative = $name.Substring($recipe.node.prefix.Length).TrimEnd('/')
    if (-not $relative) { continue }
    if ($relative -match '[\\:\x00-\x1f<>"|?*]' -or $relative.StartsWith('/') -or ($relative.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[. ]$|^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)' })) { throw 'Unsafe portable Node ZIP path' }
    if (-not $names.Add($relative)) { throw 'Case-colliding Node ZIP paths' }
    $mode = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($mode -notin @(0,0x4000,0x8000) -or ($entry.ExternalAttributes -band 0x400)) { throw 'Node ZIP contains a link or special file' }
    $total += $entry.Length
    if ($entry.Length -gt 512MB -or $total -gt 2GB) { throw 'Portable Node ZIP expanded bound exceeded' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archive,$stage)
$nodeDirectory = Join-Path $stage ($recipe.node.prefix.TrimEnd('/'))
$node = Join-Path $nodeDirectory 'node.exe'
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Portable Node executable missing' }
$actual = & $node --version
if ($LASTEXITCODE -ne 0 -or $actual -ne 'v24.22.1') { throw 'Portable Node version differs' }
if ($env:GITHUB_ENV) { 'STILL_RELEASE_NODE=' + $node | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append }
if ($env:GITHUB_PATH) { $nodeDirectory | Out-File -LiteralPath $env:GITHUB_PATH -Encoding utf8 -Append }
Write-Output 'Reviewed portable Node ZIP verified and prepared.'
