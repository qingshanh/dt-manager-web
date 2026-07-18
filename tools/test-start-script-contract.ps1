$ErrorActionPreference = "Stop"
$source = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "start.ps1") -Raw -Encoding UTF8
$script:assertions = 0
[scriptblock]::Create($source) | Out-Null

function Assert-Match {
  param([string]$Pattern, [string]$Message)
  $script:assertions++
  if ($source -notmatch $Pattern) {
    throw "Missing start.ps1 contract: $Message (pattern: $Pattern)"
  }
}

function Assert-NotMatch {
  param([string]$Pattern, [string]$Message)
  $script:assertions++
  if ($source -match $Pattern) {
    throw "Forbidden start.ps1 contract: $Message (pattern: $Pattern)"
  }
}

Assert-Match 'runtime-process-lib\.ps1' "shared lifecycle library"
Assert-Match '_tmp\\runtime' "fixed runtime directory"
Assert-Match 'processes\.json' "fixed manifest filename"
Assert-Match '\[guid\]::NewGuid\(\)' "fresh instance id"
Assert-Match 'New-RuntimeManifest' "manifest creation"
Assert-Match 'Read-RuntimeManifest' "stale manifest inspection"
Assert-Match 'Write-RuntimeManifestAtomic' "atomic manifest persistence"
Assert-Match 'Add-RuntimeService' "service ownership registration"
Assert-Match 'Get-ProcessCreationTime' "PID creation-time capture"
Assert-Match 'Get-PortOwnerProcessId' "foreign port ownership detection"
Assert-Match 'DT_RUNTIME_INSTANCE_ID' "instance marker injection"
Assert-Match 'DT_ALLOW_APP_FALLBACK' "explicit app fallback policy"
Assert-Match 'WithHelper\.IsPresent\.ToString\(\)\.ToLowerInvariant\(\)' "helper controls fallback"
Assert-Match 'ExpectedInstanceId' "health identity expectation"
Assert-Match 'ConvertFrom-Json' "health JSON parsing"
Assert-Match 'instanceId\s+-ne\s+\$ExpectedInstanceId' "health identity comparison"
Assert-Match 'catch\s*\{' "partial-start catch cleanup"
Assert-Match 'Stop-OwnedRuntimeService' "owned-service rollback"
Assert-Match 'Stop-LegacyRuntimeService' "recovery of preserved legacy migration manifests"
Assert-Match '\.legacy' "legacy migration manifest marker handling"
Assert-Match 'Remove-RuntimeManifest' "manifest rollback"
Assert-Match 'pendingProcessSnapshots' "tracking for processes started before manifest registration"
Assert-Match 'Stop-RuntimeProcessIfUnchanged' "PID and creation-time cleanup for unregistered startup processes"
Assert-Match 'cleanup failed.*preserving runtime manifest|preserv.*manifest' "manifest preservation when partial cleanup fails"
Assert-Match 'SetEnvironmentVariable\("DT_HELPER_TOKEN"' "helper token inherited through the parent environment"
Assert-Match 'SetEnvironmentVariable\("DT_REAL_BRIDGE_TOKEN"' "backend bridge token inherited through the parent environment"
Assert-Match 'IsNullOrWhiteSpace\(\$helperToken\)[\s\S]*NewGuid' "helper launch never uses an empty authentication token"
Assert-NotMatch '"`\$env:DT_HELPER_TOKEN\s*=' "helper token must not be embedded in a child command line"
Assert-NotMatch 'Stop-ProjectProcesses' "broad command-line regex cleanup"

$lifecycleSource = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "tools\test-local-lifecycle.ps1") -Raw -Encoding UTF8
$script:assertions++
if ($lifecycleSource -match 'Start-Process[^\r\n]*-Wait') {
  throw "Lifecycle harness must not use Start-Process -Wait because launched services remain in the child process tree."
}
$script:assertions++
if ($lifecycleSource -notmatch 'Start-Process[^\r\n]*-WindowStyle Hidden[^\r\n]*-PassThru') {
  throw "Lifecycle harness must isolate child PowerShell console handles and retain its process handle."
}
$script:assertions++
if ($lifecycleSource -notmatch '\$process\.WaitForExit\(\)[\s\S]*\$process\.Refresh\(\)[\s\S]*\$process\.ExitCode') {
  throw "Lifecycle harness must wait for and refresh the isolated script process before reading ExitCode."
}

Write-Host "start.ps1 contract tests passed ($script:assertions assertions)"
