function ConvertTo-NormalizedRuntimePath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function New-RuntimeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$InstanceId
  )

  return [pscustomobject]@{
    schemaVersion = 1
    projectRoot = ConvertTo-NormalizedRuntimePath -Path $ProjectRoot
    instanceId = $InstanceId
    startedAt = [datetime]::UtcNow.ToString("o")
    services = @()
  }
}

function Read-RuntimeManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$ExpectedProjectRoot = ""
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  try {
    $manifest = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "Runtime manifest is invalid JSON: $Path. $($_.Exception.Message)"
  }

  if ($null -eq $manifest -or $manifest.schemaVersion -ne 1 -or -not $manifest.projectRoot -or -not $manifest.instanceId) {
    throw "Runtime manifest has an invalid schema: $Path"
  }
  if ($null -eq $manifest.services) {
    $manifest | Add-Member -NotePropertyName services -NotePropertyValue @()
  }

  if ($ExpectedProjectRoot) {
    $expected = ConvertTo-NormalizedRuntimePath -Path $ExpectedProjectRoot
    $actual = ConvertTo-NormalizedRuntimePath -Path ([string]$manifest.projectRoot)
    if (-not [string]::Equals($expected, $actual, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Runtime manifest projectRoot does not match this project. Expected '$expected', got '$actual'."
    }
  }

  return $manifest
}

function Write-RuntimeManifestAtomic {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Manifest
  )

  $directory = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporaryPath = $Path + ".tmp"
  try {
    $json = $Manifest | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Add-RuntimeService {
  param(
    [Parameter(Mandatory = $true)]$Manifest,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][int]$RootPid,
    [Parameter(Mandatory = $true)][string]$CreationTime,
    [Parameter(Mandatory = $true)][int]$Port
  )

  $remaining = @($Manifest.services | Where-Object { $_.name -ne $Name })
  $service = [pscustomobject]@{
    name = $Name
    rootPid = $RootPid
    creationTime = $CreationTime
    port = $Port
  }
  $Manifest.services = @($remaining + $service)
  return $Manifest
}

function Remove-RuntimeManifest {
  param([Parameter(Mandatory = $true)][string]$Path)

  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Get-RuntimeProcessRecord {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Get-ProcessCreationTime {
  param([Parameter(Mandatory = $true)][int]$ProcessId)

  $process = Get-RuntimeProcessRecord -ProcessId $ProcessId
  if ($null -eq $process -or $null -eq $process.CreationDate) {
    return $null
  }
  if ($process.CreationDate -is [datetime]) {
    return ([datetime]$process.CreationDate).ToUniversalTime().ToString("o")
  }
  return [string]$process.CreationDate
}

function Test-RuntimeCreationTimeEqual {
  param([string]$Expected, $Actual)

  if (-not $Expected -or $null -eq $Actual) {
    return $false
  }
  $expectedDate = [datetime]::MinValue
  $actualDate = [datetime]::MinValue
  if ([datetime]::TryParse($Expected, [ref]$expectedDate) -and [datetime]::TryParse([string]$Actual, [ref]$actualDate)) {
    return [math]::Abs(($expectedDate.ToUniversalTime() - $actualDate.ToUniversalTime()).TotalSeconds) -lt 1
  }
  return [string]::Equals($Expected, [string]$Actual, [System.StringComparison]::Ordinal)
}

function Test-OwnedRuntimeProcess {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$CreationTime,
    [Parameter(Mandatory = $true)][string]$InstanceId
  )

  $process = Get-RuntimeProcessRecord -ProcessId $ProcessId
  if ($null -eq $process -or -not (Test-RuntimeCreationTimeEqual -Expected $CreationTime -Actual $process.CreationDate)) {
    return $false
  }
  if (-not $process.CommandLine) {
    return $false
  }
  $escapedInstanceId = [regex]::Escape($InstanceId)
  return [bool](($process.CommandLine -match "DT_RUNTIME_INSTANCE_ID") -and ($process.CommandLine -match $escapedInstanceId))
}

function Get-DescendantProcessSnapshot {
  param([Parameter(Mandatory = $true)][int]$RootPid)

  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byParent = @{}
  foreach ($process in $all) {
    $parentKey = [string]$process.ParentProcessId
    if (-not $byParent.ContainsKey($parentKey)) {
      $byParent[$parentKey] = @()
    }
    $byParent[$parentKey] = @($byParent[$parentKey]) + $process
  }

  $result = @()
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($RootPid)
  while ($queue.Count -gt 0) {
    $parentPid = [int]$queue.Dequeue()
    $key = [string]$parentPid
    if (-not $byParent.ContainsKey($key)) {
      continue
    }
    foreach ($child in @($byParent[$key])) {
      $creationTime = if ($child.CreationDate -is [datetime]) {
        ([datetime]$child.CreationDate).ToUniversalTime().ToString("o")
      } else {
        [string]$child.CreationDate
      }
      $result += [pscustomobject]@{
        processId = [int]$child.ProcessId
        creationTime = $creationTime
      }
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
  return @($result)
}

function Get-RuntimeServiceDescendantSnapshots {
  param([Parameter(Mandatory = $true)]$Service)

  $property = $Service.PSObject.Properties["descendantSnapshots"]
  if ($null -eq $property -or $null -eq $property.Value) {
    return @()
  }
  return @($property.Value)
}

function Set-RuntimeServiceDescendantSnapshots {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][object[]]$Snapshots
  )

  $value = @()
  $seen = @{}
  $existingSnapshots = @(Get-RuntimeServiceDescendantSnapshots -Service $Service)
  $newSnapshots = @($Snapshots)
  foreach ($snapshot in @($existingSnapshots + $newSnapshots)) {
    $key = "{0}|{1}" -f ([int]$snapshot.processId), ([string]$snapshot.creationTime)
    if ($seen.ContainsKey($key)) {
      continue
    }
    $seen[$key] = $true
    $value += $snapshot
  }
  if ($null -eq $Service.PSObject.Properties["descendantSnapshots"]) {
    $Service | Add-Member -NotePropertyName descendantSnapshots -NotePropertyValue $value
  } else {
    $Service.descendantSnapshots = $value
  }
  return $Service
}

function Test-RuntimeProcessSnapshotUnchanged {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $record = Get-RuntimeProcessRecord -ProcessId ([int]$Snapshot.processId)
  if ($null -eq $record) {
    return $false
  }
  return Test-RuntimeCreationTimeEqual -Expected ([string]$Snapshot.creationTime) -Actual $record.CreationDate
}

function Stop-RuntimeProcessIfUnchanged {
  param([Parameter(Mandatory = $true)]$Snapshot)

  $record = Get-RuntimeProcessRecord -ProcessId ([int]$Snapshot.processId)
  if ($null -eq $record) {
    return $true
  }
  if (-not (Test-RuntimeCreationTimeEqual -Expected ([string]$Snapshot.creationTime) -Actual $record.CreationDate)) {
    return $false
  }
  Stop-Process -Id ([int]$Snapshot.processId) -Force -ErrorAction SilentlyContinue
  Wait-Process -Id ([int]$Snapshot.processId) -Timeout 5 -ErrorAction SilentlyContinue
  return $null -eq (Get-RuntimeProcessRecord -ProcessId ([int]$Snapshot.processId))
}

function Stop-OwnedRuntimeService {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][string]$InstanceId
  )

  $rootRecord = Get-RuntimeProcessRecord -ProcessId ([int]$Service.rootPid)
  $descendants = @(Get-RuntimeServiceDescendantSnapshots -Service $Service)
  if ($null -ne $rootRecord) {
    if (-not (Test-OwnedRuntimeProcess -ProcessId ([int]$Service.rootPid) -CreationTime ([string]$Service.creationTime) -InstanceId $InstanceId)) {
      return $false
    }
    $currentDescendants = @(Get-DescendantProcessSnapshot -RootPid ([int]$Service.rootPid))
    Set-RuntimeServiceDescendantSnapshots -Service $Service -Snapshots $currentDescendants | Out-Null
    $descendants = @(Get-RuntimeServiceDescendantSnapshots -Service $Service)
    Stop-Process -Id ([int]$Service.rootPid) -Force -ErrorAction SilentlyContinue
    Wait-Process -Id ([int]$Service.rootPid) -Timeout 5 -ErrorAction SilentlyContinue
  }

  $descendantsStopped = $true
  foreach ($snapshot in $descendants) {
    if (-not (Stop-RuntimeProcessIfUnchanged -Snapshot $snapshot)) {
      $descendantsStopped = $false
    }
  }
  foreach ($snapshot in $descendants) {
    if (Test-RuntimeProcessSnapshotUnchanged -Snapshot $snapshot) {
      $descendantsStopped = $false
    }
  }
  return $null -eq (Get-RuntimeProcessRecord -ProcessId ([int]$Service.rootPid)) -and $descendantsStopped
}

function Get-PortOwnerProcessId {
  param([Parameter(Mandatory = $true)][int]$Port)

  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $owner) {
      return [int]$owner.OwningProcess
    }
  }
  return $null
}

function Test-RuntimeManifestResiduals {
  param([Parameter(Mandatory = $true)]$Manifest)

  $residuals = @()
  foreach ($service in @($Manifest.services)) {
    $isLegacy = $null -ne $service.PSObject.Properties["legacy"] -and [bool]$service.legacy
    if ($isLegacy -and (Test-RuntimeProcessSnapshotUnchanged -Snapshot ([pscustomobject]@{
      processId = [int]$service.rootPid
      creationTime = [string]$service.creationTime
    }))) {
      $residuals += "Legacy service '$($service.name)' still owns PID $($service.rootPid)."
    } elseif (-not $isLegacy -and (Test-OwnedRuntimeProcess -ProcessId ([int]$service.rootPid) -CreationTime ([string]$service.creationTime) -InstanceId ([string]$Manifest.instanceId))) {
      $residuals += "Service '$($service.name)' still owns PID $($service.rootPid)."
    }
    foreach ($snapshot in @(Get-RuntimeServiceDescendantSnapshots -Service $service)) {
      if (Test-RuntimeProcessSnapshotUnchanged -Snapshot $snapshot) {
        $residuals += "Service '$($service.name)' descendant PID $($snapshot.processId) is still running."
      }
    }
    $portOwner = Get-PortOwnerProcessId -Port ([int]$service.port)
    if ($null -ne $portOwner) {
      $residuals += "Service '$($service.name)' port $($service.port) is still owned by PID $portOwner."
    }
  }
  return @($residuals)
}

function Get-RuntimeAncestorChain {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [object[]]$ProcessSnapshot = @()
  )

  $all = if ($ProcessSnapshot.Count -gt 0) { @($ProcessSnapshot) } else { @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) }
  $byId = @{}
  foreach ($process in $all) {
    $byId[[string]$process.ProcessId] = $process
  }
  $chain = @()
  $currentId = $ProcessId
  $seen = @{}
  while ($currentId -gt 0 -and -not $seen.ContainsKey([string]$currentId)) {
    $seen[[string]$currentId] = $true
    $current = $byId[[string]$currentId]
    if ($null -eq $current) {
      break
    }
    $chain += $current
    $currentId = [int]$current.ParentProcessId
  }
  return @($chain)
}

function Test-LegacyBackendHealth {
  param([Parameter(Mandatory = $true)][int]$Port)

  try {
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $Port) -TimeoutSec 2
    return $health.ok -eq $true -and $health.version -and $health.gatewayMode -in @("mock", "real", "bridge", "direct")
  } catch {
    return $false
  }
}

function Find-LegacyRuntimeService {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("backend", "frontend", "helper")][string]$Name,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  $ownerPid = Get-PortOwnerProcessId -Port $Port
  if ($null -eq $ownerPid) {
    return $null
  }
  $snapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $chain = @(Get-RuntimeAncestorChain -ProcessId $ownerPid -ProcessSnapshot $snapshot)
  if ($chain.Count -eq 0) {
    return [pscustomobject]@{ status = "suspicious"; name = $Name; port = $Port; ownerPid = $ownerPid; reason = "process chain unavailable" }
  }

  $ownerCommand = [string]$chain[0].CommandLine
  $expectedOwner = switch ($Name) {
    "backend" { $ownerCommand -match '(?i)(--import\s+tsx\s+src[\\/]index\.ts|node(?:\.exe)?\s+dist[\\/]index\.js)' }
    "frontend" { $ownerCommand -match '(?i)(vite(?:\.js)?|vite[\\/]bin[\\/]vite\.js)' }
    "helper" { $ownerCommand -match '(?i)python(?:\.exe)?\s+server\.py' }
  }
  if (-not $expectedOwner) {
    return [pscustomobject]@{ status = "foreign"; name = $Name; port = $Port; ownerPid = $ownerPid; reason = "owner command does not match project service" }
  }
  if ($Name -eq "backend" -and -not (Test-LegacyBackendHealth -Port $Port)) {
    return [pscustomobject]@{ status = "suspicious"; name = $Name; port = $Port; ownerPid = $ownerPid; reason = "backend health signature did not match" }
  }

  $normalizedRoot = ConvertTo-NormalizedRuntimePath -Path $ProjectRoot
  $escapedRoot = [regex]::Escape($normalizedRoot)
  $projectMarked = @($chain | Where-Object { $_.CommandLine -and [string]$_.CommandLine -match $escapedRoot }).Count -gt 0
  $backendChainMarked = $Name -eq "backend" -and @($chain | Where-Object {
    $_.CommandLine -and [string]$_.CommandLine -match '(?i)(scripts[\\/]dev-supervisor\.mjs|node(?:\.exe)?\s+dist[\\/]index\.js)'
  }).Count -gt 0
  if (-not $projectMarked -and -not $backendChainMarked) {
    return [pscustomobject]@{ status = "suspicious"; name = $Name; port = $Port; ownerPid = $ownerPid; reason = "ancestor chain has no project-root marker" }
  }

  $rootProcess = $chain[0]
  if ($Name -eq "backend") {
    $supervisor = @($chain | Where-Object {
      $_.CommandLine -and [string]$_.CommandLine -match '(?i)scripts[\\/]dev-supervisor\.mjs'
    }) | Select-Object -First 1
    if ($null -ne $supervisor) {
      $rootProcess = $supervisor
    }
  }
  $creationTime = if ($rootProcess.CreationDate -is [datetime]) {
    ([datetime]$rootProcess.CreationDate).ToUniversalTime().ToString("o")
  } else {
    [string]$rootProcess.CreationDate
  }
  return [pscustomobject]@{
    status = "owned"
    name = $Name
    port = $Port
    ownerPid = [int]$ownerPid
    rootPid = [int]$rootProcess.ProcessId
    creationTime = $creationTime
  }
}

function Stop-LegacyRuntimeService {
  param([Parameter(Mandatory = $true)]$Service)

  $root = Get-RuntimeProcessRecord -ProcessId ([int]$Service.rootPid)
  $descendants = @(Get-RuntimeServiceDescendantSnapshots -Service $Service)
  if ($null -ne $root) {
    if (-not (Test-RuntimeCreationTimeEqual -Expected ([string]$Service.creationTime) -Actual $root.CreationDate)) {
      return $false
    }
    $currentDescendants = @(Get-DescendantProcessSnapshot -RootPid ([int]$Service.rootPid))
    Set-RuntimeServiceDescendantSnapshots -Service $Service -Snapshots $currentDescendants | Out-Null
    $descendants = @(Get-RuntimeServiceDescendantSnapshots -Service $Service)
    Stop-Process -Id ([int]$Service.rootPid) -Force -ErrorAction SilentlyContinue
    Wait-Process -Id ([int]$Service.rootPid) -Timeout 5 -ErrorAction SilentlyContinue
  }
  $descendantsStopped = $true
  foreach ($snapshot in $descendants) {
    if (-not (Stop-RuntimeProcessIfUnchanged -Snapshot $snapshot)) {
      $descendantsStopped = $false
    }
  }
  foreach ($snapshot in $descendants) {
    if (Test-RuntimeProcessSnapshotUnchanged -Snapshot $snapshot) {
      $descendantsStopped = $false
    }
  }
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-Date) -lt $deadline -and $null -ne (Get-PortOwnerProcessId -Port ([int]$Service.port))) {
    Start-Sleep -Milliseconds 100
  }
  return $descendantsStopped -and $null -eq (Get-RuntimeProcessRecord -ProcessId ([int]$Service.rootPid)) -and
    $null -eq (Get-PortOwnerProcessId -Port ([int]$Service.port))
}
