#!/usr/bin/env pwsh
# Usage: pwsh scripts/bump-version.ps1
# Increments the build number for today, or resets to -build-1 on a new day.

$versionFile = Join-Path $PSScriptRoot ".." "VERSION"
$date = Get-Date -Format "yyyy-MM-dd"

if (Test-Path $versionFile) {
    $current = (Get-Content $versionFile -Raw).Trim()
    if ($current -match "^(\d{4}-\d{2}-\d{2})-build-(\d+)$") {
        if ($Matches[1] -eq $date) {
            $n = [int]$Matches[2] + 1
        } else {
            $n = 1
        }
    } else {
        $n = 1
    }
} else {
    $n = 1
}

$newVersion = "$date-build-$($n.ToString('000'))"
Set-Content -Path $versionFile -Value $newVersion -NoNewline
Write-Host "Version bumped to: $newVersion"
