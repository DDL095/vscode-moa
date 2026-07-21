Add-Type -AssemblyName System.Drawing
$size = 128
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

# 渐变背景（紫）
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 0)),
  (New-Object System.Drawing.Point($size, $size)),
  [System.Drawing.Color]::FromArgb(99, 102, 241),
  [System.Drawing.Color]::FromArgb(139, 92, 246)
)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 24
$path.AddArc(0, 0, $r, $r, 180, 90)
$path.AddArc($size - $r, 0, $r, $r, 270, 90)
$path.AddArc($size - $r, $size - $r, $r, $r, 0, 90)
$path.AddArc(0, $size - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath($bg, $path)

# 桥接线（白）
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(200, 255, 255, 255), 3)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($pen, 40, 44, 88, 44)
$g.DrawLine($pen, 40, 44, 64, 84)
$g.DrawLine($pen, 88, 44, 64, 84)

# 三个节点（白）
$g.FillEllipse([System.Drawing.Brushes]::White, 26, 30, 28, 28)
$g.FillEllipse([System.Drawing.Brushes]::White, 74, 30, 28, 28)
$g.FillEllipse([System.Drawing.Brushes]::White, 50, 70, 28, 28)

$g.Dispose()
$outPath = Join-Path $PSScriptRoot '..' 'resources' 'moa-icon.png'
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK: $outPath"
