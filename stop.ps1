param()

$ErrorActionPreference = "Stop"

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
  $patterns = @(
    "dt-manager-web\\backend",
    "dt-manager-web\\frontend",
    "dt-manager-web\\backend\\helper",
    "dt-manager-web[\\/]+backend",
    "dt-manager-web[\\/]+frontend",
    "dt-manager-web[\\/]+backend[\\/]+helper",
    "tsx\\dist\\cli\.mjs.*backend",
    "tsx[\\/]+dist[\\/]+cli\.mjs.*backend",
    "vite\\bin\\vite\.js.*frontend",
    "vite[\\/]+bin[\\/]+vite\.js.*frontend",
    "backend[\\/]+node_modules[\\/]+tsx",
    "frontend[\\/]+node_modules[\\/]+vite",
    "python .*server\.py"
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
      foreach ($pattern in $patterns) {
        if ($process.CommandLine -match $pattern) {
          $targeted += $process
          break
        }
      }
    }
  } catch {
    Write-Host "[cleanup] unable to inspect process command lines, skipping targeted cleanup"
    return
  }

  foreach ($process in $targeted) {
    if (Stop-ProcessTree -ProcessId $process.ProcessId) {
      Write-Host ("[cleanup] stopped process pid {0}" -f $process.ProcessId)
    } else {
      Write-Host ("[cleanup] failed to stop process pid {0}" -f $process.ProcessId)
    }
  }
}

Write-Host "[cleanup] stopping leftover project processes..."
Stop-ProjectProcesses
