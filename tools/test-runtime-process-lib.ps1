$ErrorActionPreference = "Stop"

$script:assertions = 0

function Assert-Equal {
  param($Expected, $Actual, [string]$Message = "")
  $script:assertions++
  if ($Expected -ne $Actual) {
    throw "Assert-Equal failed. Expected=[$Expected], Actual=[$Actual]. $Message"
  }
}

function Assert-True {
  param([bool]$Condition, [string]$Message = "")
  $script:assertions++
  if (-not $Condition) {
    throw "Assert-True failed. $Message"
  }
}

function Assert-False {
  param([bool]$Condition, [string]$Message = "")
  $script:assertions++
  if ($Condition) {
    throw "Assert-False failed. $Message"
  }
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Pattern)
  $script:assertions++
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch $Pattern) {
      throw "Assert-Throws got unexpected message: $($_.Exception.Message)"
    }
    return
  }
  throw "Assert-Throws failed. Expected an exception matching [$Pattern]."
}

. (Join-Path $PSScriptRoot "runtime-process-lib.ps1")

$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dt-runtime-lib-test-" + [guid]::NewGuid().ToString("N"))
$otherRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dt-runtime-lib-other-" + [guid]::NewGuid().ToString("N"))
$manifestPath = Join-Path $tempRoot "runtime\processes.json"

try {
  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  New-Item -ItemType Directory -Force -Path $otherRoot | Out-Null

  $manifest = New-RuntimeManifest -ProjectRoot $tempRoot -InstanceId "test-instance"
  Assert-Equal 1 $manifest.schemaVersion
  Assert-Equal "test-instance" $manifest.instanceId
  Assert-Equal 0 @($manifest.services).Count
  Assert-True ([datetime]::TryParse($manifest.startedAt, [ref]([datetime]::MinValue))) "startedAt should be ISO-compatible"

  $manifest = Add-RuntimeService -Manifest $manifest -Name "backend" -RootPid 1234 `
    -CreationTime "20260716120000.000000+480" -Port 5174
  Assert-Equal "backend" $manifest.services[0].name
  Assert-Equal 1234 $manifest.services[0].rootPid
  Assert-Equal 5174 $manifest.services[0].port

  $manifest = Add-RuntimeService -Manifest $manifest -Name "backend" -RootPid 5678 `
    -CreationTime "20260716120100.000000+480" -Port 6174
  Assert-Equal 1 @($manifest.services).Count "duplicate service should be replaced"
  Assert-Equal 5678 $manifest.services[0].rootPid
  Assert-Equal 6174 $manifest.services[0].port

  Write-RuntimeManifestAtomic -Path $manifestPath -Manifest $manifest
  Assert-True (Test-Path -LiteralPath $manifestPath) "manifest should exist after atomic write"
  Assert-True (-not (Test-Path -LiteralPath ($manifestPath + ".tmp"))) "atomic temp file should not remain"

  $readBack = Read-RuntimeManifest -Path $manifestPath -ExpectedProjectRoot $tempRoot
  Assert-Equal "test-instance" $readBack.instanceId
  Assert-Equal 5678 $readBack.services[0].rootPid

  Assert-Throws { Read-RuntimeManifest -Path $manifestPath -ExpectedProjectRoot $otherRoot } "projectRoot"

  Set-Content -LiteralPath $manifestPath -Value "{broken-json" -Encoding UTF8
  Assert-Throws { Read-RuntimeManifest -Path $manifestPath -ExpectedProjectRoot $tempRoot } "invalid|JSON|manifest"

  $missingService = [pscustomobject]@{
    name = "missing"
    rootPid = 2147483647
    creationTime = "2026-07-16T00:00:00.0000000Z"
    port = 65534
  }
  Assert-True (Stop-OwnedRuntimeService -Service $missingService -InstanceId "test-instance") "an already-exited owned root should be idempotent"

  $serviceWithRecordedDescendant = [pscustomobject]@{
    descendantSnapshots = @([pscustomobject]@{ processId = 101; creationTime = "first" })
  }
  Set-RuntimeServiceDescendantSnapshots -Service $serviceWithRecordedDescendant -Snapshots @(
    [pscustomobject]@{ processId = 202; creationTime = "second" }
  ) | Out-Null
  Assert-Equal 2 @($serviceWithRecordedDescendant.descendantSnapshots).Count `
    "new descendant captures must preserve earlier ownership evidence"

  $mockRootPid = 12345
  $mockChildPid = 12346
  $mockCreationTime = "2026-07-16T00:00:00.0000000Z"
  $script:mockRootGone = $false
  function Get-RuntimeProcessRecord {
    param([int]$ProcessId)
    if ($ProcessId -eq $mockRootPid -and -not $script:mockRootGone) {
      return [pscustomobject]@{
        ProcessId = $mockRootPid
        CreationDate = [datetime]$mockCreationTime
        CommandLine = "powershell -Command `$env:DT_RUNTIME_INSTANCE_ID='test-instance'"
      }
    }
    return $null
  }
  function Get-DescendantProcessSnapshot {
    return @([pscustomobject]@{ processId = $mockChildPid; creationTime = $mockCreationTime })
  }
  function Stop-Process {
    param([int]$Id)
    if ($Id -eq $mockRootPid) {
      $script:mockRootGone = $true
    }
  }
  function Wait-Process { param([int]$Id) }
  function Stop-RuntimeProcessIfUnchanged { return $false }
  function Get-PortOwnerProcessId { return $null }

  $ownedServiceWithStuckChild = [pscustomobject]@{
    name = "backend"
    rootPid = $mockRootPid
    creationTime = $mockCreationTime
    port = 5174
    descendantSnapshots = @([pscustomobject]@{ processId = $mockChildPid; creationTime = $mockCreationTime })
  }
  Assert-False (Stop-OwnedRuntimeService -Service $ownedServiceWithStuckChild -InstanceId "test-instance") `
    "owned service stop must fail when an unchanged descendant cannot be stopped"

  $script:mockRootGone = $false
  $legacyServiceWithStuckChild = [pscustomobject]@{
    name = "backend"
    rootPid = $mockRootPid
    creationTime = $mockCreationTime
    port = 5174
    descendantSnapshots = @([pscustomobject]@{ processId = $mockChildPid; creationTime = $mockCreationTime })
  }
  Assert-False (Stop-LegacyRuntimeService -Service $legacyServiceWithStuckChild) `
    "legacy stop must fail when an unchanged descendant cannot be stopped"

  function Get-RuntimeProcessRecord {
    param([int]$ProcessId)
    if ($ProcessId -eq $mockChildPid) {
      return [pscustomobject]@{ ProcessId = $mockChildPid; CreationDate = [datetime]$mockCreationTime }
    }
    return $null
  }
  $manifestWithResidualChild = [pscustomobject]@{
    instanceId = "test-instance"
    services = @($ownedServiceWithStuckChild)
  }
  $residuals = @(Test-RuntimeManifestResiduals -Manifest $manifestWithResidualChild)
  Assert-True (@($residuals | Where-Object { $_ -match "descendant.*$mockChildPid" }).Count -eq 1) `
    "manifest residual checks must report unchanged descendant snapshots"

  function Get-RuntimeProcessRecord {
    param([int]$ProcessId)
    if ($ProcessId -eq $mockRootPid) {
      return [pscustomobject]@{ ProcessId = $mockRootPid; CreationDate = [datetime]$mockCreationTime }
    }
    return $null
  }
  $legacyManifest = [pscustomobject]@{
    instanceId = "legacy-migration"
    services = @([pscustomobject]@{
      name = "backend"
      rootPid = $mockRootPid
      creationTime = $mockCreationTime
      port = 5174
      legacy = $true
      descendantSnapshots = @()
    })
  }
  $legacyResiduals = @(Test-RuntimeManifestResiduals -Manifest $legacyManifest)
  Assert-True (@($legacyResiduals | Where-Object { $_ -match "legacy.*$mockRootPid" }).Count -eq 1) `
    "legacy migration manifests must report an unchanged root process"

  . (Join-Path $PSScriptRoot "runtime-process-lib.ps1")

  Remove-RuntimeManifest -Path $manifestPath
  Remove-RuntimeManifest -Path $manifestPath
  Assert-True (-not (Test-Path -LiteralPath $manifestPath)) "removal should be idempotent"

  Write-Host "runtime-process-lib tests passed ($script:assertions assertions)"
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $otherRoot -Recurse -Force -ErrorAction SilentlyContinue
}
