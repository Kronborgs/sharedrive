[CmdletBinding()]
param(
  [string]$OutputPath = 'docs/rooms-gif-candidate-pool.json',
  [int]$ResultsPerTerm = 50,
  [int]$DelaySeconds = 1
)

$ErrorActionPreference = 'Stop'
$apiBase = 'https://commons.wikimedia.org/w/api.php'
$queries = @(
  @{ category='hello'; terms=@('intitle:waving hand','intitle:hand wave','"waving hand" animation','intitle:greeting animation') },
  @{ category='goodbye'; terms=@('intitle:goodbye animation','intitle:farewell animation','"waving goodbye" gif') },
  @{ category='yes'; terms=@('intitle:thumbs up animation','intitle:approving animation','intitle:yes animation','"hand gesture" like gif') },
  @{ category='no'; terms=@('intitle:thumbs down animation','intitle:disapproving animation','intitle:no animation') },
  @{ category='applause'; terms=@('intitle:clapping animation','intitle:applause animation','intitle:bravo gif') },
  @{ category='congratulations'; terms=@('intitle:congratulations animation','"good job" animation','"well done" animation','intitle:graduation animation') },
  @{ category='celebrate'; terms=@('intitle:celebration animation','intitle:confetti animation','intitle:fireworks animation','"party animation" gif') },
  @{ category='happy'; terms=@('intitle:happy animation','intitle:smile animation','intitle:smiley gif','intitle:joy animation') },
  @{ category='laugh'; terms=@('intitle:laughing animation','intitle:funny animation','intitle:laughter gif') },
  @{ category='wow'; terms=@('intitle:surprised animation','intitle:wow animation','intitle:shock animation','intitle:astonished animation') },
  @{ category='thinking'; terms=@('intitle:thinking animation','intitle:pondering animation','intitle:idea animation') },
  @{ category='confused'; terms=@('intitle:confused animation','intitle:shrug animation','intitle:question animation') },
  @{ category='sad'; terms=@('intitle:sad animation','intitle:crying animation','intitle:tears animation') },
  @{ category='angry'; terms=@('intitle:angry animation','intitle:frustrated animation','intitle:rage animation') },
  @{ category='thanks'; terms=@('intitle:thank you animation','intitle:thanks animation','"thank you" gif') },
  @{ category='welcome'; terms=@('intitle:welcome animation','"welcome" animated gif') },
  @{ category='dance'; terms=@('intitle:dancing animated','intitle:dance gif','"dancing people" animation') },
  @{ category='cheer'; terms=@('intitle:cheering animation','intitle:victory animation','intitle:success animation') },
  @{ category='work'; terms=@('intitle:writing animation','intitle:typing animation','intitle:working animation','intitle:computer animation') },
  @{ category='animals'; terms=@('intitle:cat animation','intitle:dog animation','intitle:penguin animation','intitle:monkey animation','intitle:rabbit animation','intitle:animal gif') }
)
$headers = @{ 'User-Agent' = 'SharedriveRoomsGIFSeed/1.0 (self-hosted starter library discovery)' }
$candidates = @{}

function Invoke-CommonsAPI {
  param([string]$Uri)
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      return Invoke-RestMethod -Uri $Uri -Headers $headers -TimeoutSec 30
    } catch {
      if ($_.Exception.Message -notmatch '429|temporarily unavailable|timed out' -or $attempt -eq 5) { throw }
      Start-Sleep -Seconds ($attempt * 10)
    }
  }
}

foreach ($group in $queries) {
  foreach ($term in $group.terms) {
    $query = [uri]::EscapeDataString($term)
    $uri = "${apiBase}?action=query&generator=search&gsrnamespace=6&gsrlimit=$ResultsPerTerm&gsrsearch=$query&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&format=json"
    try {
      $response = Invoke-CommonsAPI -Uri $uri
      foreach ($page in @($response.query.pages.psobject.Properties.Value)) {
        $info = $page.imageinfo[0]
        if ($null -eq $info -or $info.mime -ne 'image/gif' -or [int64]$info.size -gt 5MB) { continue }
        $license = [string]$info.extmetadata.LicenseShortName.value
        if ($license -notmatch '^(CC0|Public domain|CC BY|CC BY-SA)') { continue }
        if ($candidates.ContainsKey($page.title)) {
          $existing = $candidates[$page.title]
          $existing.source_terms = @($existing.source_terms + $term | Select-Object -Unique)
          $existing.source_categories = @($existing.source_categories + $group.category | Select-Object -Unique)
          continue
        }
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
          source_categories = @($group.category)
        }
      }
    } catch {
      Write-Warning "Skipping '$term': $($_.Exception.Message)"
    }
    Write-Progress -Activity 'Discovering Commons GIFs' -Status "$($group.category): $term" -PercentComplete -1
    Start-Sleep -Seconds $DelaySeconds
  }
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
@($candidates.Values) | ConvertTo-Json -Depth 6 | Set-Content -Path $OutputPath -Encoding utf8
Write-Host "Wrote $($candidates.Count) verified GIF candidates to $OutputPath"
