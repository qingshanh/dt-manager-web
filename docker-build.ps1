param(
  [switch]$WithHelper,
  [switch]$NoCache
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeFile = Join-Path $root "docker-compose.yml"
$services = @("backend", "frontend")
if ($WithHelper) {
  $services += "helper"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Missing command: docker"
}

$args = @("compose", "-f", $composeFile, "build")
if ($NoCache) {
  $args += "--no-cache"
}
$args += $services

Write-Host ("Building services: {0}" -f ($services -join ", "))
& docker @args
