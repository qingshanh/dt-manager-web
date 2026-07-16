param(
  [switch]$Execute,
  [ValidateRange(1, 10)][int]$Iterations = 1,
  [switch]$SkipInstall,
  [switch]$TestPortConflict
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root "_tmp\runtime\processes.json"
$powershellExe = (Get-Command powershell.exe).Source

if (-not $Execute) {
  Write-Host "Lifecycle integration is disabled by default because it starts and stops real local services."
  Write-Host "After recording/stopping any legacy unmanaged instance, rerun with:"
  Write-Host "  powershell -NoProfile -ExecutionPolicy Bypass -File tools\test-local-lifecycle.ps1 -Execute -Iterations 1 -SkipInstall"
  exit 0
}

function Invoke-LifecycleScript {
  param([string]$ScriptName, [string[]]$Arguments = @())

  $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root $ScriptName)) + $Arguments
  $process = Start-Process -FilePath $powershellExe -ArgumentList $argumentList -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  $process.Refresh()
  return $process.ExitCode
}

function Assert-PortFree {
  param([int]$Port)
  $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $owner) {
    throw "Port $Port remains owned by PID $($owner.OwningProcess)."
  }
}

function Assert-NoManifest {
  if (Test-Path -LiteralPath $manifestPath) {
    throw "Runtime manifest remains after stop: $manifestPath"
  }
}

$seenInstances = @{}
for ($iteration = 1; $iteration -le $Iterations; $iteration++) {
  $startArguments = @()
  if ($SkipInstall) {
    $startArguments += "-SkipInstall"
  }
  if ((Invoke-LifecycleScript -ScriptName "start.ps1" -Arguments $startArguments) -ne 0) {
    throw "start.ps1 failed in iteration $iteration"
  }

  $health = Invoke-RestMethod -Uri "http://127.0.0.1:5174/health" -TimeoutSec 5
  $parsedInstance = [guid]::Empty
  if (-not [guid]::TryParse([string]$health.instanceId, [ref]$parsedInstance)) {
    throw "Health returned invalid instanceId '$($health.instanceId)'"
  }
  if ($seenInstances.ContainsKey([string]$health.instanceId)) {
    throw "Instance id was reused: $($health.instanceId)"
  }
  $seenInstances[[string]$health.instanceId] = $true

  if ((Invoke-LifecycleScript -ScriptName "stop.ps1") -ne 0) {
    throw "stop.ps1 failed in iteration $iteration"
  }
  Assert-PortFree -Port 5173
  Assert-PortFree -Port 5174
  Assert-NoManifest
}

if ($TestPortConflict) {
  $fixture = Start-Process -FilePath (Get-Command node.exe).Source `
    -ArgumentList @("-e", "require('http').createServer((q,s)=>s.end('fixture')).listen(5174);setInterval(()=>{},1000)") `
    -WindowStyle Hidden -PassThru
  try {
    Start-Sleep -Milliseconds 500
    $exitCode = Invoke-LifecycleScript -ScriptName "start.ps1" -Arguments @("-SkipInstall")
    if ($exitCode -eq 0) {
      throw "start.ps1 unexpectedly succeeded while port 5174 was occupied"
    }
    if ($fixture.HasExited) {
      throw "start.ps1 terminated the unrelated port-conflict fixture"
    }
  } finally {
    Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Lifecycle integration passed ($Iterations iterations)."
