param(
  [switch]$WithHelper,
  [string]$HelperDeviceMode = "",
  [string]$HelperRemoteHost = "",
  [string]$HelperDeviceId = "",
  [Nullable[int]]$BackendPort = $null,
  [Nullable[int]]$FrontendPort = $null,
  [Nullable[int]]$HelperPort = $null,
  [switch]$SkipInstall,
  [switch]$OpenBrowser
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $root "backend"
$frontendDir = Join-Path $root "frontend"
$helperDir = Join-Path $backendDir "helper"
$logDir = Join-Path $root "_tmp\logs"
$powershellExe = (Get-Command powershell.exe).Source
$envFile = Join-Path $root ".env"

try {
  [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $OutputEncoding = [Console]::OutputEncoding
} catch {
}

function Assert-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing command: $Name"
  }
}

function Escape-SingleQuote {
  param([string]$Value)
  return $Value.Replace("'", "''")
}

function Import-DotEnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    Write-Host ("[env] root .env not found at {0}; using process defaults" -f $Path)
    return
  }

  foreach ($line in Get-Content -LiteralPath $Path -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith("#") -or $trimmed -notmatch "^\s*([^#=]+?)\s*=\s*(.*)\s*$") {
      continue
    }
    $key = $Matches[1].Trim()
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($key, $value, "Process")
  }
  Write-Host ("[env] loaded {0}" -f $Path)
}

function Resolve-EnvInt {
  param(
    [Nullable[int]]$Value,
    [string[]]$Names,
    [int]$Default
  )

  if ($null -ne $Value -and $Value -gt 0) {
    return [int]$Value
  }
  foreach ($name in $Names) {
    $raw = [Environment]::GetEnvironmentVariable($name, "Process")
    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
      return $parsed
    }
  }
  return $Default
}

function Resolve-EnvString {
  param(
    [string]$Value,
    [string]$Name,
    [string]$Default
  )

  if ($Value) {
    return $Value
  }
  $raw = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ($raw) {
    return $raw
  }
  return $Default
}

function Invoke-WorkingDirectoryCommand {
  param(
    [string]$WorkingDirectory,
    [scriptblock]$ScriptBlock
  )

  Push-Location $WorkingDirectory
  try {
    & $ScriptBlock
  } finally {
    Pop-Location
  }
}

function Start-DetachedPowerShell {
  param(
    [string]$Name,
    [string]$WorkingDirectory,
    [string]$Command
  )

  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  $stdoutPath = Join-Path $logDir ("{0}.out.log" -f $Name)
  $stderrPath = Join-Path $logDir ("{0}.err.log" -f $Name)

  $process = Start-Process `
    -FilePath $powershellExe `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $Command) `
    -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru

  Write-Host ("[{0}] started (pid {1}, logs {2})" -f $Name, $process.Id, $stdoutPath)
  return $process
}

function Wait-HttpEndpoint {
  param(
    [string]$Name,
    [string]$Url,
    [int]$TimeoutSeconds = 30
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ([int]$response.StatusCode -ge 200 -and [int]$response.StatusCode -lt 500) {
        Write-Host ("[{0}] ready at {1}" -f $Name, $Url)
        return
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 500
  }

  $stdoutPath = Join-Path $logDir ("{0}.out.log" -f $Name)
  $stderrPath = Join-Path $logDir ("{0}.err.log" -f $Name)
  throw ("{0} did not become ready at {1}. Last error: {2}. Logs: {3}, {4}" -f $Name, $Url, $lastError, $stdoutPath, $stderrPath)
}

function Stop-ProcessTree {
  param([int]$ProcessId)

  $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$ProcessId" -ErrorAction SilentlyContinue
  foreach ($child in $children) {
    Stop-ProcessTree -ProcessId $child.ProcessId | Out-Null
  }

  if (-not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)) {
    return $true
  }

  try {
    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    Wait-Process -Id $ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    return -not (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

function Stop-ProjectProcesses {
  param([string]$ProjectRoot)

  $patterns = @(
    "Set-Location -LiteralPath '.*\\backend'",
    "Set-Location -LiteralPath '.*\\frontend'",
    "Set-Location -LiteralPath '.*\\backend\\helper'",
    "dt-manager-web[\\/]+backend",
    "dt-manager-web[\\/]+frontend",
    "dt-manager-web[\\/]+backend[\\/]+helper",
    "dt-manager-web\\backend\\node_modules",
    "dt-manager-web\\frontend\\node_modules",
    "dt-manager-web\\backend\\helper\\server\.py",
    "backend[\\/]+node_modules[\\/]+tsx",
    "frontend[\\/]+node_modules[\\/]+vite",
    "npm-cli\.js.*--prefix .*dt-manager-web",
    "tsx\\dist\\cli\.mjs.*backend",
    "tsx[\\/]+dist[\\/]+cli\.mjs.*backend",
    "vite\\bin\\vite\.js.*frontend",
    "vite[\\/]+bin[\\/]+vite\.js.*frontend",
    "python server\.py"
  )
  $allowedNames = @("node.exe", "python.exe", "powershell.exe", "pwsh.exe")
  $selfPid = $PID

  $targeted = @()
  try {
    foreach ($process in Get-CimInstance Win32_Process) {
      if ($process.ProcessId -eq $selfPid -or $allowedNames -notcontains $process.Name) {
        continue
      }
      if (-not $process.CommandLine) {
        continue
      }
      $isMatch = $false
      foreach ($pattern in $patterns) {
        if ($process.CommandLine -match $pattern) {
          $isMatch = $true
          break
        }
      }
      if ($isMatch) {
        $targeted += $process
      }
    }
  } catch {
    Write-Host "[cleanup] 无法读取进程命令行，跳过旧进程清理后继续启动"
    return
  }

  foreach ($process in $targeted) {
    try {
      Stop-ProcessTree -ProcessId $process.ProcessId | Out-Null
      Write-Host ("[cleanup] stopped old project process pid {0}" -f $process.ProcessId)
    } catch {
      Write-Host ("[cleanup] failed to stop pid {0}: {1}" -f $process.ProcessId, $_.Exception.Message)
    }
  }

  Start-Sleep -Seconds 1

  try {
    foreach ($process in Get-CimInstance Win32_Process) {
      if ($process.ProcessId -eq $selfPid -or $allowedNames -notcontains $process.Name -or -not $process.CommandLine) {
        continue
      }
      foreach ($pattern in $patterns) {
        if ($process.CommandLine -match $pattern) {
          try {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
            Write-Host ("[cleanup] stopped lingering project process pid {0}" -f $process.ProcessId)
          } catch {
            Write-Host ("[cleanup] failed to stop lingering pid {0}: {1}" -f $process.ProcessId, $_.Exception.Message)
          }
          break
        }
      }
    }
  } catch {
    Write-Host "[cleanup] 无法读取剩余进程列表，已跳过收尾清理"
  }
}

function Invoke-WithRetry {
  param(
    [string]$Name,
    [scriptblock]$Action,
    [int]$Retries = 3,
    [int]$DelaySeconds = 2
  )

  for ($attempt = 1; $attempt -le $Retries; $attempt++) {
    try {
      & $Action
      return
    } catch {
      $message = $_.Exception.Message
      if ($attempt -ge $Retries -or $message -notmatch 'EPERM|access is denied|access denied|rename') {
        throw
      }
      Write-Host ("[{0}] attempt {1} failed, retrying in {2}s: {3}" -f $Name, $attempt, $DelaySeconds, $message)
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}

function Test-PrismaClientReady {
  $clientDir = Join-Path $backendDir "node_modules\.prisma\client"
  return (Test-Path -LiteralPath (Join-Path $clientDir "index.js")) -and
    (Test-Path -LiteralPath (Join-Path $clientDir "query_engine-windows.dll.node"))
}

function Test-PrismaEngineLocked {
  $enginePath = Join-Path $backendDir "node_modules\.prisma\client\query_engine-windows.dll.node"
  if (-not (Test-Path -LiteralPath $enginePath)) {
    return $false
  }

  $stream = $null
  try {
    $stream = [System.IO.File]::Open($enginePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    return $false
  } catch {
    return $true
  } finally {
    if ($null -ne $stream) {
      $stream.Close()
    }
  }
}

function Invoke-PrismaGenerate {
  Push-Location $backendDir
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $output = & npx prisma generate 2>&1
    $exitCode = $LASTEXITCODE
    foreach ($line in $output) {
      Write-Host $line
    }
    if ($exitCode -ne 0) {
      throw ($output -join [Environment]::NewLine)
    }
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    Pop-Location
  }
}

Import-DotEnvFile -Path $envFile

$BackendPort = Resolve-EnvInt -Value $BackendPort -Names @("PORT", "BACKEND_PORT") -Default 5174
$FrontendPort = Resolve-EnvInt -Value $FrontendPort -Names @("VITE_DEV_PORT", "FRONTEND_PORT") -Default 5173
$HelperPort = Resolve-EnvInt -Value $HelperPort -Names @("HELPER_PORT", "DT_HELPER_PORT") -Default 5175
$HelperDeviceMode = Resolve-EnvString -Value $HelperDeviceMode -Name "DT_HELPER_DEVICE_MODE" -Default "usb"
$HelperRemoteHost = Resolve-EnvString -Value $HelperRemoteHost -Name "DT_HELPER_REMOTE_HOST" -Default "127.0.0.1:27042"
$HelperDeviceId = Resolve-EnvString -Value $HelperDeviceId -Name "DT_HELPER_DEVICE_ID" -Default ""

if (@("usb", "local", "remote", "id") -notcontains $HelperDeviceMode) {
  throw "Invalid HelperDeviceMode '$HelperDeviceMode'. Expected usb, local, remote, or id."
}

Assert-Command npm
Assert-Command python

Write-Host "[cleanup] stopping leftover project processes..."
Stop-ProjectProcesses -ProjectRoot $root

if (-not $SkipInstall) {
  if (-not (Test-Path (Join-Path $backendDir "node_modules"))) {
    Write-Host "[backend] installing dependencies..."
    Invoke-WorkingDirectoryCommand $backendDir { npm install }
  }

  if (-not (Test-Path (Join-Path $frontendDir "node_modules"))) {
    Write-Host "[frontend] installing dependencies..."
    Invoke-WorkingDirectoryCommand $frontendDir { npm install }
  }
}

if ((Test-PrismaClientReady) -and (Test-PrismaEngineLocked)) {
  Write-Host "[backend] Prisma client engine is locked by another local process; skipping generate and using existing client."
  Write-Host "[backend] To force regeneration, close other tools using this project and run: cd backend; npx prisma generate"
} else {
  Write-Host "[backend] generating Prisma client..."
  try {
    Invoke-WithRetry -Name "prisma generate" -Retries 5 -DelaySeconds 3 -Action {
      Invoke-PrismaGenerate
    }
  } catch {
    $message = $_.Exception.Message
    if ($message -match 'EPERM|access is denied|access denied|rename' -and (Test-PrismaClientReady)) {
      Write-Host "[backend] Prisma client engine is locked by another local process; using existing generated client."
      Write-Host "[backend] To force regeneration, close other tools using this project and run: cd backend; npx prisma generate"
    } else {
      throw
    }
  }
}

Write-Host "[backend] applying Prisma migrations..."
Invoke-WorkingDirectoryCommand $backendDir { npx prisma migrate deploy }

if ($WithHelper) {
  Write-Host "[helper] checking frida Python package..."
  & python -c "import frida"
  if ($LASTEXITCODE -ne 0) {
    throw "Python package 'frida' is missing. Install it first (for example: python -m pip install frida)."
  }

  if (-not $SkipInstall -and -not (Test-Path (Join-Path $helperDir "node_modules"))) {
    Write-Host "[helper] installing frida agent npm dependencies..."
    Invoke-WorkingDirectoryCommand $helperDir { npm install }
  }
}

$processes = @()

$backendUrl = "http://localhost:$BackendPort"
$frontendUrl = "http://localhost:$FrontendPort"
$helperUrl = "http://127.0.0.1:$HelperPort"
$appVersion = Resolve-EnvString -Value "" -Name "APP_VERSION" -Default "0.2.6"
$viteAppVersion = Resolve-EnvString -Value "" -Name "VITE_APP_VERSION" -Default $appVersion
$helperBindHost = Resolve-EnvString -Value "" -Name "DT_HELPER_BIND_HOST" -Default "127.0.0.1"
$helperToken = Resolve-EnvString -Value "" -Name "DT_HELPER_TOKEN" -Default ""
$corsOrigin = Resolve-EnvString -Value "" -Name "CORS_ORIGIN" -Default "$frontendUrl,http://127.0.0.1:$FrontendPort"
$viteDevHost = Resolve-EnvString -Value "" -Name "VITE_DEV_HOST" -Default "0.0.0.0"

$backendCommand = @(
  "Set-Location -LiteralPath '" + (Escape-SingleQuote $backendDir) + "';"
  "`$env:DT_ENV_FILE = '" + (Escape-SingleQuote $envFile) + "';"
  "`$env:PORT = '$BackendPort';"
  "`$env:APP_VERSION = '" + (Escape-SingleQuote $appVersion) + "';"
  "`$env:CORS_ORIGIN = '" + (Escape-SingleQuote $corsOrigin) + "';"
  "npm run dev"
) -join " "
$processes += Start-DetachedPowerShell -Name "backend" -WorkingDirectory $backendDir -Command $backendCommand

$frontendCommand = @(
  "Set-Location -LiteralPath '" + (Escape-SingleQuote $frontendDir) + "';"
  "`$env:VITE_DEV_PORT = '$FrontendPort';"
  "`$env:VITE_BACKEND_URL = '$backendUrl';"
  "`$env:VITE_APP_VERSION = '" + (Escape-SingleQuote $viteAppVersion) + "';"
  "npm run dev -- --host '" + (Escape-SingleQuote $viteDevHost) + "'"
) -join " "
$processes += Start-DetachedPowerShell -Name "frontend" -WorkingDirectory $frontendDir -Command $frontendCommand

if ($WithHelper) {
  $helperCommand = @(
    "Set-Location -LiteralPath '" + (Escape-SingleQuote $helperDir) + "';"
    "`$env:DT_HELPER_BIND_HOST = '" + (Escape-SingleQuote $helperBindHost) + "';"
    "`$env:DT_HELPER_PORT = '$HelperPort';"
    "`$env:DT_HELPER_DEVICE_MODE = '" + (Escape-SingleQuote $HelperDeviceMode) + "';"
    "`$env:DT_HELPER_REMOTE_HOST = '" + (Escape-SingleQuote $HelperRemoteHost) + "';"
    "`$env:DT_HELPER_DEVICE_ID = '" + (Escape-SingleQuote $HelperDeviceId) + "';"
    "`$env:DT_HELPER_TOKEN = '" + (Escape-SingleQuote $helperToken) + "';"
    "python server.py"
  ) -join " "
  $processes += Start-DetachedPowerShell -Name "helper" -WorkingDirectory $helperDir -Command $helperCommand
}

Wait-HttpEndpoint -Name "backend" -Url "$backendUrl/health"
Wait-HttpEndpoint -Name "frontend" -Url $frontendUrl
if ($WithHelper) {
  Wait-HttpEndpoint -Name "helper" -Url "$helperUrl/health"
}

Write-Host ""
Write-Host "Ready:"
Write-Host "  Frontend: $frontendUrl"
Write-Host "  Backend:  $backendUrl/health"
if ($WithHelper) {
  Write-Host "  Helper:   $helperUrl/health"
  Write-Host "  Helper mode: $HelperDeviceMode"
  if ($HelperDeviceMode -eq "remote") {
    Write-Host "  Helper remote host: $HelperRemoteHost"
  }
}

if ($OpenBrowser) {
  Start-Process $frontendUrl
}

Write-Host ""
Write-Host "Use stop.bat or stop.ps1 to stop the services."
