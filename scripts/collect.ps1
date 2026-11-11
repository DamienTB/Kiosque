# Kiosque - collecteur de flux RSS/Atom
# Lit sources.json, recupere les articles recents de chaque journal
# et ecrit data/pool.json, que l'application utilise pour composer l'edition du matin.
# Compatible Windows PowerShell 5.1 et PowerShell 7 (GitHub Actions).

param(
  [int]$MaxAgeHours = 36,     # articles d'aujourd'hui et de la veille
  [int]$MaxPerSource = 30,
  [string]$Only = ""          # pour tester un seul journal : -Only lemonde
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$sourcesPath = Join-Path $root "sources.json"
$outDir = Join-Path $root "data"
$outPath = Join-Path $outDir "pool.json"

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Net.Http

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$handler.AllowAutoRedirect = $true
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(25)
$client.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 KiosqueReader/1.0")
$client.DefaultRequestHeaders.Accept.ParseAdd("application/rss+xml, application/atom+xml, application/xml, text/xml, */*")

function Get-FeedXml([string]$url) {
  $bytes = $client.GetByteArrayAsync($url).GetAwaiter().GetResult()
  # Certains flux ont des espaces avant "<?xml" : on les saute (sauf BOM)
  $start = 0
  while ($start -lt $bytes.Length -and ($bytes[$start] -eq 0x20 -or $bytes[$start] -eq 0x0A -or $bytes[$start] -eq 0x0D -or $bytes[$start] -eq 0x09)) { $start++ }
  $len = $bytes.Length - $start
  $ms = New-Object System.IO.MemoryStream -ArgumentList @($bytes, $start, $len)
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Ignore
  $settings.XmlResolver = $null
  $settings.CheckCharacters = $false
  $reader = [System.Xml.XmlReader]::Create($ms, $settings)
  $doc = New-Object System.Xml.XmlDocument
  $doc.Load($reader)
  $reader.Close()
  return $doc
}

function Get-Children($node, [string]$localName) {
  $result = @()
  foreach ($c in $node.ChildNodes) {
    if ($c.NodeType -eq [System.Xml.XmlNodeType]::Element -and $c.LocalName -eq $localName) { $result += $c }
  }
  return $result
}

function Get-Text($node, [string]$localName) {
  $c = @(Get-Children $node $localName)
  if ($c.Count -gt 0) { return $c[0].InnerText.Trim() }
  return ""
}

function Clean-Html([string]$s) {
  if (-not $s) { return "" }
  $s = [regex]::Replace($s, "(?is)<(script|style)[^>]*>.*?</\1>", " ")
  $s = [regex]::Replace($s, "(?s)<[^>]+>", " ")
  $s = [System.Net.WebUtility]::HtmlDecode($s)
  $s = [System.Net.WebUtility]::HtmlDecode($s)   # certains flux sont doublement encodes
  $s = [regex]::Replace($s, "\s+", " ").Trim()
  return $s
}

function Shorten([string]$s, [int]$max) {
  if ($s.Length -le $max) { return $s }
  $cut = $s.Substring(0, $max)
  $sp = $cut.LastIndexOf(" ")
  if ($sp -gt $max * 0.6) { $cut = $cut.Substring(0, $sp) }
  return $cut.TrimEnd(" ", ",", ";", ":") + [string][char]0x2026   # points de suspension
}

$zones = @{ "GMT" = "+00:00"; "UT" = "+00:00"; "UTC" = "+00:00"; "Z" = "+00:00";
  "EST" = "-05:00"; "EDT" = "-04:00"; "CST" = "-06:00"; "CDT" = "-05:00"; "PST" = "-08:00"; "PDT" = "-07:00";
  "CET" = "+01:00"; "CEST" = "+02:00"; "BRT" = "-03:00" }

function Parse-Date([string]$s) {
  if (-not $s) { return $null }
  $t = $s.Trim()
  $t = [regex]::Replace($t, "^[A-Za-z]{3},\s*", "")            # "Tue, " inutile et parfois localise
  $m = [regex]::Match($t, "\s([A-Z]{1,4})$")
  if ($m.Success -and $zones.ContainsKey($m.Groups[1].Value)) { $t = $t.Substring(0, $m.Index) + " " + $zones[$m.Groups[1].Value] }
  $t = [regex]::Replace($t, "([+-]\d{2})(\d{2})$", '$1:$2')
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  $dto = [DateTimeOffset]::MinValue
  if ([DateTimeOffset]::TryParse($t, $inv, [System.Globalization.DateTimeStyles]::AssumeUniversal, [ref]$dto)) { return $dto.ToUniversalTime() }
  return $null
}

function Find-Image($item, [string]$html) {
  foreach ($name in @("content", "thumbnail")) {
    foreach ($c in (Get-Children $item $name)) {
      $u = $c.GetAttribute("url")
      $type = $c.GetAttribute("type"); $medium = $c.GetAttribute("medium")
      if ($u -and ($name -eq "thumbnail" -or $medium -eq "image" -or $type -like "image/*" -or (-not $type -and -not $medium))) { return $u }
    }
  }
  # media:group > media:content
  foreach ($g in (Get-Children $item "group")) {
    foreach ($c in (Get-Children $g "content")) { $u = $c.GetAttribute("url"); if ($u) { return $u } }
    foreach ($c in (Get-Children $g "thumbnail")) { $u = $c.GetAttribute("url"); if ($u) { return $u } }
  }
  foreach ($c in (Get-Children $item "enclosure")) {
    $u = $c.GetAttribute("url"); $type = $c.GetAttribute("type")
    if ($u -and ($type -like "image/*" -or $u -match "\.(jpe?g|png|webp)(\?|$)")) { return $u }
  }
  if ($html) {
    $m = [regex]::Match($html, '(?i)<img[^>]+src=["'']([^"'']+)["'']')
    if ($m.Success) { return [System.Net.WebUtility]::HtmlDecode($m.Groups[1].Value) }
  }
  return $null
}

function Read-Entries($doc) {
  $entries = @()
  $rootEl = $doc.DocumentElement
  if ($rootEl.LocalName -eq "feed") {
    foreach ($e in (Get-Children $rootEl "entry")) {
      $link = ""
      foreach ($l in (Get-Children $e "link")) {
        $rel = $l.GetAttribute("rel")
        if (-not $rel -or $rel -eq "alternate") { $link = $l.GetAttribute("href"); break }
      }
      $html = Get-Text $e "summary"
      if (-not $html) { $html = Get-Text $e "content" }
      $date = Get-Text $e "published"; if (-not $date) { $date = Get-Text $e "updated" }
      $entries += [pscustomobject]@{ title = Get-Text $e "title"; link = $link; html = $html; fullHtml = (Get-Text $e "content"); date = $date; node = $e; category = "" }
    }
  } else {
    $channel = @(Get-Children $rootEl "channel")
    $parent = $rootEl
    if ($channel.Count -gt 0) { $parent = $channel[0] }
    $items = @(Get-Children $parent "item")
    if ($items.Count -eq 0) { $items = @(Get-Children $rootEl "item") }   # RSS 1.0 / RDF
    foreach ($e in $items) {
      $link = Get-Text $e "link"
      if (-not $link) { $g = Get-Text $e "guid"; if ($g -like "http*") { $link = $g } }
      $date = Get-Text $e "pubDate"; if (-not $date) { $date = Get-Text $e "date" }
      $cats = @(Get-Children $e "category")
      $cat = ""; if ($cats.Count -gt 0) { $cat = $cats[0].InnerText.Trim() }
      $entries += [pscustomobject]@{ title = Get-Text $e "title"; link = $link; html = (Get-Text $e "description"); fullHtml = (Get-Text $e "encoded"); date = $date; node = $e; category = $cat }
    }
  }
  return $entries
}

$sources = Get-Content -Raw -Encoding UTF8 $sourcesPath | ConvertFrom-Json
$now = [DateTimeOffset]::UtcNow
$cutoff = $now.AddHours(-$MaxAgeHours)
$all = New-Object System.Collections.ArrayList
$report = @()

foreach ($src in $sources) {
  if ($Only -and $src.id -ne $Only) { continue }
  $seen = @{}
  $kept = New-Object System.Collections.ArrayList
  $status = "ok"
  foreach ($url in $src.feeds) {
    try {
      $doc = Get-FeedXml $url
      foreach ($en in (Read-Entries $doc)) {
        if (-not $en.link -or -not $en.title) { continue }
        $link = $en.link.Trim()
        if ($seen.ContainsKey($link)) { continue }
        $seen[$link] = $true
        $published = Parse-Date $en.date
        if ($published -and $published -lt $cutoff) { continue }
        if ($published -and $published -gt $now.AddHours(2)) { $published = $now }
        $summary = Clean-Html $en.html
        if (-not $summary -and $en.fullHtml) { $summary = Clean-Html $en.fullHtml }
        $title = Clean-Html $en.title
        if ($summary -eq $title) { $summary = "" }
        $img = Find-Image $en.node ($en.html + " " + $en.fullHtml)
        if ($img -and $img.StartsWith("//")) { $img = "https:" + $img }
        $pubStr = $null; if ($published) { $pubStr = $published.ToString("yyyy-MM-ddTHH:mm:ssZ") }
        $id = $src.id + ":" + ([BitConverter]::ToString(([System.Security.Cryptography.SHA1]::Create()).ComputeHash([Text.Encoding]::UTF8.GetBytes($link))).Replace("-", "").Substring(0, 12).ToLower())
        [void]$kept.Add([ordered]@{
          id = $id; source = $src.id; title = $title; summary = (Shorten $summary 320)
          link = $link; image = $img; published = $pubStr; category = (Clean-Html $en.category)
        })
      }
    } catch {
      $status = "ERREUR: " + $_.Exception.GetBaseException().Message
    }
  }
  $sorted = @($kept | Sort-Object -Property @{ Expression = { if ($_.published) { $_.published } else { "0" } } } -Descending | Select-Object -First $MaxPerSource)
  foreach ($k in $sorted) { [void]$all.Add($k) }
  $report += [pscustomobject]@{ Journal = $src.name; Articles = $sorted.Count; Avecimage = @($sorted | Where-Object { $_.image }).Count; Statut = $status }
}

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$pool = [ordered]@{ generatedAt = $now.ToString("yyyy-MM-ddTHH:mm:ssZ"); items = $all.ToArray() }
$json = ConvertTo-Json -InputObject $pool -Depth 6 -Compress
[System.IO.File]::WriteAllText($outPath, $json, (New-Object System.Text.UTF8Encoding($false)))

$report | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host ("Total : {0} articles -> {1}" -f $all.Count, $outPath)
