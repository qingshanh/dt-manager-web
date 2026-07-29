param(
  [ValidateRange(1024, 65535)][int]$BackendPort = 5274,
  [ValidateRange(1024, 65535)][int]$FrontendPort = 5273
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$backendDir = Join-Path $root "backend"
$manifestPath = Join-Path $root "_tmp\runtime\processes.json"
$powershellExe = (Get-Command powershell.exe).Source
. (Join-Path $root "tools\runtime-process-lib.ps1")

if (Test-Path -LiteralPath $manifestPath) {
  throw "Refusing to run while a managed local runtime is active: $manifestPath"
}

function Wait-Endpoint {
  param([string]$Url, [int]$TimeoutSeconds = 30)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) {
        return
      }
    } catch {
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Endpoint did not become ready: $Url"
}

function Invoke-ProjectScript {
  param([string]$ScriptName, [string[]]$Arguments = @())

  $argumentList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $root $ScriptName)) + $Arguments
  $process = Start-Process -FilePath $powershellExe -ArgumentList $argumentList -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $process.WaitForExit()
  $process.Refresh()
  return $process.ExitCode
}

$fixtureCommand = @(
  "Set-Location -LiteralPath '" + $backendDir.Replace("'", "''") + "';"
  "`$env:PORT = '$BackendPort';"
  "npm run dev"
) -join " "
$fixture = Start-Process -FilePath $powershellExe -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  $fixtureCommand
) -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru
$managedRuntimeStarted = $false

try {
  Wait-Endpoint -Url "http://127.0.0.1:$BackendPort/health"
  if (Test-Path -LiteralPath $manifestPath) {
    throw "Fixture unexpectedly created the runtime manifest: $manifestPath"
  }

  $startExitCode = Invoke-ProjectScript -ScriptName "start.ps1" -Arguments @(
    "-SkipInstall",
    "-BackendPort", [string]$BackendPort,
    "-FrontendPort", [string]$FrontendPort
  )
  if ($startExitCode -ne 0) {
    throw "start.ps1 did not recover the verified untracked project runtime"
  }
  $managedRuntimeStarted = $true

  Wait-Endpoint -Url "http://127.0.0.1:$BackendPort/health"
  Wait-Endpoint -Url "http://127.0.0.1:$FrontendPort"
} finally {
  if ($managedRuntimeStarted -and (Test-Path -LiteralPath $manifestPath)) {
    Invoke-ProjectScript -ScriptName "stop.ps1" | Out-Null
  }
  if (-not $fixture.HasExited) {
    Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue
  }
  $legacy = Find-LegacyRuntimeService -Name "backend" -Port $BackendPort -ProjectRoot $root
  if ($null -ne $legacy -and $legacy.status -eq "owned") {
    Stop-LegacyRuntimeService -Service $legacy | Out-Null
  }
}

Write-Host "Untracked project runtime recovery passed."
