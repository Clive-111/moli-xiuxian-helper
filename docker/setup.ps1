param([switch]$BuildOnly)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Docker command failed (exit $LASTEXITCODE)." }
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'Install and start Docker Desktop with Linux containers first.' }
Invoke-Docker compose config --quiet
New-Item -ItemType Directory -Force -Path 'data/control','logs/docker' | Out-Null
Invoke-Docker compose build battle
if ($BuildOnly) { return }
Invoke-Docker compose up -d --no-build battle
Write-Host 'Started the independent battle project. Default panel: http://localhost:7081'
Write-Host 'Default browser view: http://localhost:7080/vnc.html. Custom ports are in .env.'
Write-Host 'Sign in manually, detect and confirm your character, select a map, then start.'
