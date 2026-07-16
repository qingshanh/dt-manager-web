$ErrorActionPreference = "Stop"
$source = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "stop.ps1") -Raw -Encoding UTF8
$script:assertions = 0
[scriptblock]::Create($source) | Out-Null

function Assert-Match {
  param([string]$Pattern, [string]$Message)
  $script:assertions++
  if ($source -notmatch $Pattern) {
    throw "Missing stop.ps1 contract: $Message (pattern: $Pattern)"
  }
}

function Assert-NotMatch {
  param([string]$Pattern, [string]$Message)
  $script:assertions++
  if ($source -match $Pattern) {
    throw "Forbidden stop.ps1 contract: $Message (pattern: $Pattern)"
  }
}

Assert-Match 'runtime-process-lib\.ps1' "shared lifecycle library"
Assert-Match '_tmp\\runtime' "fixed runtime directory"
Assert-Match 'processes\.json' "fixed manifest filename"
Assert-Match 'Read-RuntimeManifest' "manifest-first ownership"
Assert-Match 'ExpectedProjectRoot' "project root validation"
Assert-Match 'Stop-OwnedRuntimeService' "verified service stop"
Assert-Match 'Test-RuntimeManifestResiduals' "post-stop residual verification"
Assert-Match 'Remove-RuntimeManifest' "manifest removal after success"
Assert-Match 'exit\s+1' "nonzero residual failure"
Assert-Match 'exit\s+0' "idempotent success"
Assert-Match 'Sort-Object' "deterministic root/supervisor stop order"
Assert-Match 'Stop-LegacyRuntimeServices' "strict migration fallback for pre-manifest launches"
Assert-Match 'Find-LegacyRuntimeService' "port and process-chain legacy verification"
Assert-Match 'Refusing to stop unverified legacy' "unverified legacy process refusal"
Assert-Match 'legacy\s*=\s*\$true' "legacy process ownership recorded in a migration manifest"
Assert-Match 'New-RuntimeManifest' "migration manifest creation before legacy termination"
Assert-Match 'descendantSnapshots' "descendant snapshots persisted before process termination"
Assert-Match 'Write-RuntimeManifestAtomic' "updated ownership evidence persisted before process termination"
Assert-Match 'services\).Count\s*-eq\s*0|services\.Count\s*-eq\s*0' "empty manifests fall back to strict legacy discovery"
Assert-NotMatch 'taskkill\s+/IM\s+node' "global Node termination"
Assert-NotMatch 'Get-CimInstance\s+Win32_Process\).*CommandLine\s+-match' "primary command-line regex scanning"
Assert-NotMatch 'Stop-ProjectProcesses' "legacy broad project cleanup"

Write-Host "stop.ps1 contract tests passed ($script:assertions assertions)"
