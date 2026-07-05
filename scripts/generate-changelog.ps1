#!/usr/bin/env pwsh
param(
    [int]$Count = 20
)

$root = Join-Path $PSScriptRoot ".."
$outFile = Join-Path $root "frontend/src/changelog.generated.ts"

try {
    $null = git rev-parse --is-inside-work-tree 2>$null
} catch {
    Write-Host "Not inside a git repository; skipping changelog generation"
    exit 0
}

$pretty = "%h|%ad|%s"
$lines = git log -n $Count --date=format:%d.%m.%Y "--pretty=format:$pretty"

$out = New-Object System.Collections.Generic.List[string]
$out.Add("export type ChangelogEntry = {")
$out.Add("  hash: string")
$out.Add("  date: string")
$out.Add("  message: string")
$out.Add("}")
$out.Add("")
$out.Add("export const CHANGELOG_ENTRIES: ChangelogEntry[] = [")

foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $parts = $line -split '\|', 3
    if ($parts.Count -lt 3) { continue }

    $hash = $parts[0].Trim()
    $date = $parts[1].Trim()
    $msgJson = ($parts[2].Trim() | ConvertTo-Json -Compress)

    $entry = "  { hash: '{0}', date: '{1}', message: {2} }," -f $hash, $date, $msgJson
    $out.Add($entry)
}

$out.Add("]")
Set-Content -Path $outFile -Value ($out -join "`n") -NoNewline
Write-Host "Changelog generated: $outFile"
