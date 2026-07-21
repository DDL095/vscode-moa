// 生成 moa-icon.png（128×128）
// 三节点 + 桥接线条，紫色渐变背景，呼应 "MoA Bridge"
const fs = require('fs');
const path = require('path');

// 用 PowerShell System.Drawing 生成
const psScript = `
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
$radius = 24
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(0, 0, $radius, $radius, 180, 90)
$path.AddArc($size - $radius, 0, $radius, $radius, 270, 90)
$path.AddArc($size - $radius, $size - $radius, $radius, $radius, 0, 90)
$path.AddArc(0, $size - $radius, $radius, $radius, 90, 90)
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
$brush = [System.Drawing.Brushes]::White
$g.FillEllipse($brush, 26, 30, 28, 28)
$g.FillEllipse($brush, 74, 30, 28, 28)
$g.FillEllipse($brush, 50, 70, 28, 28)

$g.Dispose()
$bmp.Save('${path.resolve(__dirname, 'resources/moa-icon.png').replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output 'OK'
`;

const { execSync } = require('child_process');
// 用 -Command 而非 -File（避免文件编码问题）
execSync(`pwsh -NoProfile -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { stdio: 'inherit' });
console.log('PNG generated');
