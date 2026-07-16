param()

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeDir = Join-Path $root "_tmp\runtime"
$manifestPath = Join-Path $runtimeDir "processes.json"
. (Join-Path $root "tools\runtime-process-lib.ps1")

function Read-StopEnvironment {
  $values = @{}
  $envPath = Join-Path $root ".env"
  if (-not (Test-Path -LiteralPath $envPath)) {
    return $values
  }
  foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
    if ($line -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') {
      $values[$Matches[1].Trim()] = $Matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $values
}

function Resolve-StopPort {
  param([hashtable]$Values, [string[]]$Names, [int]$Default)

  foreach ($name in $Names) {
    $raw = [Environment]::GetEnvironmentVariable($name, "Process")
    if (-not $raw -and $Values.ContainsKey($name)) {
      $raw = [string]$Values[$name]
    }
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
      return $parsed
    }
  }
  return $Default
}

function Stop-LegacyRuntimeServices {
  $values = Read-StopEnvironment
  $services = @(
    @{ name = "backend"; port = Resolve-StopPort -Values $values -Names @("PORT", "BACKEND_PORT") -Default 5174 },
    @{ name = "frontend"; port = Resolve-StopPort -Values $values -Names @("VITE_DEV_PORT", "FRONTEND_PORT") -Default 5173 },
    @{ name = "helper"; port = Resolve-StopPort -Values $values -Names @("HELPER_PORT", "DT_HELPER_PORT") -Default 5175 }
  )
  $failures = @()
  $owned = @()
  foreach ($service in $services) {
    $candidate = Find-LegacyRuntimeService -Name $service.name -Port $service.port -ProjectRoot $root
    if ($null -eq $candidate -or $candidate.status -eq "foreign") {
      continue
    }
    if ($candidate.status -ne "owned") {
      $failures += "Refusing to stop unverified legacy $($service.name) PID $($candidate.ownerPid) on port $($service.port): $($candidate.reason)."
      continue
    }
    $owned += $candidate
  }
  $legacyManifest = $null
  if ($owned.Count -gt 0) {
    $legacy = $true
    $legacyManifest = New-RuntimeManifest -ProjectRoot $root -InstanceId ("legacy-migration-" + [guid]::NewGuid().ToString("D"))
    foreach ($service in $owned) {
      $descendantSnapshots = @(Get-DescendantProcessSnapshot -RootPid ([int]$service.rootPid))
      $legacyManifest = Add-RuntimeService -Manifest $legacyManifest -Name ([string]$service.name) -RootPid ([int]$service.rootPid) `
        -CreationTime ([string]$service.creationTime) -Port ([int]$service.port)
      $recordedService = @($legacyManifest.services | Where-Object { $_.name -eq $service.name }) | Select-Object -First 1
      $recordedService | Add-Member -NotePropertyName legacy -NotePropertyValue $legacy
      Set-RuntimeServiceDescendantSnapshots -Service $recordedService -Snapshots $descendantSnapshots | Out-Null
      Set-RuntimeServiceDescendantSnapshots -Service $service -Snapshots $descendantSnapshots | Out-Null
    }
    Write-RuntimeManifestAtomic -Path $manifestPath -Manifest $legacyManifest
  }
  foreach ($service in @($owned | Sort-Object { $_.name -eq "backend" } -Descending)) {
    Write-Host ("[cleanup] stopping verified legacy {0} process tree at PID {1}..." -f $service.name, $service.rootPid)
    if (-not (Stop-LegacyRuntimeService -Service $service)) {
      $failures += "Legacy service '$($service.name)' did not fully stop; PID $($service.rootPid), port $($service.port)."
    }
  }
  if ($failures.Count -gt 0) {
    throw ($failures -join [Environment]::NewLine)
  }
  if ($null -ne $legacyManifest) {
    Remove-RuntimeManifest -Path $manifestPath
  }
  if ($owned.Count -eq 0) {
    Write-Host "[cleanup] no manifest-owned or verified legacy project services are running"
  }
}

try {
  $manifest = Read-RuntimeManifest -Path $manifestPath -ExpectedProjectRoot $root
  if ($null -eq $manifest -or @($manifest.services).Count -eq 0) {
    Stop-LegacyRuntimeServices
    if ($null -ne $manifest) {
      Remove-RuntimeManifest -Path $manifestPath
    }
    exit 0
  }

  $failures = @()
  foreach ($service in @($manifest.services)) {
    $isLegacy = $null -ne $service.PSObject.Properties["legacy"] -and [bool]$service.legacy
    $rootRecord = Get-RuntimeProcessRecord -ProcessId ([int]$service.rootPid)
    $canCapture = if ($isLegacy) {
      $null -ne $rootRecord -and (Test-RuntimeCreationTimeEqual -Expected ([string]$service.creationTime) -Actual $rootRecord.CreationDate)
    } else {
      Test-OwnedRuntimeProcess -ProcessId ([int]$service.rootPid) -CreationTime ([string]$service.creationTime) -InstanceId ([string]$manifest.instanceId)
    }
    if ($canCapture) {
      $descendantSnapshots = @(Get-DescendantProcessSnapshot -RootPid ([int]$service.rootPid))
      Set-RuntimeServiceDescendantSnapshots -Service $service -Snapshots $descendantSnapshots | Out-Null
    }
  }
  Write-RuntimeManifestAtomic -Path $manifestPath -Manifest $manifest
  foreach ($service in @($manifest.services | Sort-Object { $_.name -eq "backend" } -Descending)) {
    Write-Host ("[cleanup] stopping {0} PID {1}..." -f $service.name, $service.rootPid)
    $isLegacy = $null -ne $service.PSObject.Properties["legacy"] -and [bool]$service.legacy
    $stopped = if ($isLegacy) {
      Stop-LegacyRuntimeService -Service $service
    } else {
      Stop-OwnedRuntimeService -Service $service -InstanceId $manifest.instanceId
    }
    if (-not $stopped) {
      $failures += "Refused or failed to stop service '$($service.name)' PID $($service.rootPid); ownership could not be verified."
    }
  }

  $residuals = @(Test-RuntimeManifestResiduals -Manifest $manifest)
  $failures += $residuals
  if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
      Write-Error $failure
    }
    exit 1
  }

  Remove-RuntimeManifest -Path $manifestPath
  Write-Host "[cleanup] all manifest-owned project services stopped"
  exit 0
} catch {
  Write-Error ("[cleanup] stop failed: {0}" -f $_.Exception.Message)
  exit 1
}
