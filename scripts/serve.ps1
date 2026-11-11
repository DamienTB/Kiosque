# Petit serveur local pour tester Kiosque sur l'ordinateur : http://localhost:8765
param([int]$Port = 8765)
$root = Split-Path -Parent $PSScriptRoot
$types = @{ ".html" = "text/html; charset=utf-8"; ".js" = "text/javascript; charset=utf-8"; ".css" = "text/css; charset=utf-8";
  ".json" = "application/json; charset=utf-8"; ".webmanifest" = "application/manifest+json"; ".png" = "image/png"; ".svg" = "image/svg+xml" }
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Kiosque : http://localhost:$Port/"
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $path = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart("/")
  if (-not $path) { $path = "index.html" }
  $file = [IO.Path]::GetFullPath((Join-Path $root $path))
  $res = $ctx.Response
  if ($file.StartsWith($root) -and (Test-Path $file -PathType Leaf)) {
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
    $res.Headers.Add("Cache-Control", "no-cache")
    $bytes = [IO.File]::ReadAllBytes($file)
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $res.StatusCode = 404
  }
  $res.Close()
  Write-Host ("{0} {1}" -f $res.StatusCode, $path)
}
