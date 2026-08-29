[CmdletBinding()]
param(
  [string]$OutputPath = 'docs/rooms-gif-candidate-pool.json',
  [int]$ResultsPerTerm = 50,
  [int]$DelaySeconds = 2
)

$ErrorActionPreference = 'Stop'
$apiBase = 'https://commons.wikimedia.org/w/api.php'
$terms = @(
  'waving gif','goodbye gif','thumbs up gif','thumbs down gif','clapping gif',
  'applause gif','congratulations gif','celebration gif','party gif','happy animated gif',
  'laughing gif','surprised gif','thinking gif','confused gif','sad gif','angry gif',
  'thank you gif','welcome gif','dancing gif','cheering gif','writing gif','funny animal gif'
)
$headers = @{ 'User-Agent' = 'SharedriveRoomsGIFSeed/1.0 (self-hosted starter library discovery)' }
$candidates = @{}

foreach ($term in $terms) {
  $query = [uri]::EscapeDataString($term)
  $uri = "${apiBase}?action=query&generator=search&gsrnamespace=6&gsrlimit=$ResultsPerTerm&gsrsearch=$query&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&format=json"
  try {
    $response = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 30
    foreach ($page in @($response.query.pages.psobject.Properties.Value)) {
      $info = $page.imageinfo[0]
      if ($null -eq $info -or $info.mime -ne 'image/gif' -or [int64]$info.size -gt 5MB) { continue }
      $license = [string]$info.extmetadata.LicenseShortName.value
      if ($license -notmatch '^(CC0|Public domain|CC BY|CC BY-SA)') { continue }
      $candidates[$page.title] = [ordered]@{
        commons_filename = $page.title.Substring(5)
        commons_page = "https://commons.wikimedia.org/wiki/$([uri]::EscapeDataString($page.title).Replace('%3A',':').Replace('%20','_'))"
        original_url = $info.url
        mime_type = $info.mime
        size_bytes = [int64]$info.size
        width = $info.width
        height = $info.height
        author = [string]$info.extmetadata.Artist.value
        attribution = [string]$info.extmetadata.Attribution.value
        license = $license
        license_url = [string]$info.extmetadata.LicenseUrl.value
        source_terms = @($term)
      }
    }
  } catch {
    Write-Warning "Skipping '$term': $($_.Exception.Message)"
  }
  Start-Sleep -Seconds $DelaySeconds
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
@($candidates.Values) | ConvertTo-Json -Depth 6 | Set-Content -Path $OutputPath -Encoding utf8
Write-Host "Wrote $($candidates.Count) verified GIF candidates to $OutputPath"
