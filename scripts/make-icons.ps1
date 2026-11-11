# Genere les icones PNG de l'application (a relancer seulement si on change le logo)
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
function New-Icon([int]$size, [string]$out, [bool]$maskable) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = "AntiAlias"; $g.TextRenderingHint = "AntiAliasGridFit"
  $g.Clear([System.Drawing.Color]::Transparent)
  $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(184, 80, 42))
  if ($maskable) { $g.FillRectangle($bg, 0, 0, $size, $size) }
  else {
    $r = [int]($size * 0.22); $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, 2*$r, 2*$r, 180, 90); $path.AddArc($size-2*$r, 0, 2*$r, 2*$r, 270, 90)
    $path.AddArc($size-2*$r, $size-2*$r, 2*$r, 2*$r, 0, 90); $path.AddArc(0, $size-2*$r, 2*$r, 2*$r, 90, 90); $path.CloseFigure()
    $g.FillPath($bg, $path)
  }
  $scale = if ($maskable) { 0.62 } else { 0.8 }
  # soleil levant derriere la lettre
  $sun = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(245, 200, 120))
  $d = $size * 0.42 * $scale
  $g.FillEllipse($sun, [float]($size*0.5 + $size*0.08*$scale), [float]($size*0.5 - $size*0.36*$scale), [float]$d, [float]$d)
  $font = New-Object System.Drawing.Font("Georgia", [float]($size * 0.62 * $scale), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = "Center"; $fmt.LineAlignment = "Center"
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 253, 248))
  $g.DrawString("K", $font, $white, (New-Object System.Drawing.RectangleF(0, [float]($size*0.03), $size, $size)), $fmt)
  # deux lignes de journal
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 253, 248), [float]($size*0.035*$scale))
  $pen.StartCap = "Round"; $pen.EndCap = "Round"
  $y = $size*0.5 + $size*0.40*$scale
  $g.DrawLine($pen, [float]($size*0.5 - $size*0.3*$scale), [float]$y, [float]($size*0.5 + $size*0.3*$scale), [float]$y)
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
New-Icon 192 (Join-Path $root "icons\icon-192.png") $false
New-Icon 512 (Join-Path $root "icons\icon-512.png") $false
New-Icon 512 (Join-Path $root "icons\icon-maskable-512.png") $true
Write-Host "Icones generees."
