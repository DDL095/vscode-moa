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

# 主流白色连线（渐变 - 顶到底）
$lineBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Point(0, 14)),
  (New-Object System.Drawing.Point(0, 104)),
  ([System.Drawing.Color]::FromArgb(115, 255, 255, 255)),
  ([System.Drawing.Color]::FromArgb(242, 255, 255, 255))
)
$pen = New-Object System.Drawing.Pen($lineBrush, 2.5)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

# 主流：Layer1(input, 56,14) → Layer2(Planner, 56,32) → Layer3(Refs fan-out) → Layer4(Aggregator) → Layer5(Actor)
$g.DrawLine($pen, 56, 18, 56, 28)         # input → Planner
# Planner → 3 Refs
$g.DrawLine($pen, 56, 36, 36, 54)
$g.DrawLine($pen, 56, 36, 56, 54)
$g.DrawLine($pen, 56, 36, 76, 54)
# 3 Refs → Aggregator
$g.DrawLine($pen, 36, 62, 56, 78)
$g.DrawLine($pen, 56, 62, 56, 78)
$g.DrawLine($pen, 76, 62, 56, 78)
# Aggregator → Actor
$g.DrawLine($pen, 56, 84, 56, 98)

# 反馈环（金色）：Aggregator(62,80) → (100,80) → (100,32) → Planner(64,32) 带箭头
# 设计依据：Aggregator 决策 next_action='recon_needed' 时触发新一轮 Recon
#          Actor 是终态执行者（写文件/跑命令），不参与迭代决策
$goldPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(251, 191, 36), 2)
$goldPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$goldPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$feedbackPoints = @(
  (New-Object System.Drawing.Point(62, 80)),
  (New-Object System.Drawing.Point(100, 80)),
  (New-Object System.Drawing.Point(100, 32)),
  (New-Object System.Drawing.Point(64, 32))
)
$g.DrawLines($goldPen, $feedbackPoints)

# 箭头（手绘三角形，指向 Planner）
$arrowPts = @(
  (New-Object System.Drawing.PointF(64, 28)),
  (New-Object System.Drawing.PointF(60, 34)),
  (New-Object System.Drawing.PointF(68, 34))
)
$g.FillPolygon([System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(251, 191, 36)), $arrowPts)

# 节点（全白）
$g.FillEllipse([System.Drawing.Brushes]::White, 50, 8, 12, 12)     # Layer 1 Input (56, 14)
$g.FillEllipse([System.Drawing.Brushes]::White, 49, 25, 14, 14)    # Layer 2 Planner (56, 32)
$g.FillEllipse([System.Drawing.Brushes]::White, 30, 52, 12, 12)    # Ref 1 (36, 58)
$g.FillEllipse([System.Drawing.Brushes]::White, 50, 52, 12, 12)    # Ref 2 (56, 58)
$g.FillEllipse([System.Drawing.Brushes]::White, 70, 52, 12, 12)    # Ref 3 (76, 58)
$g.FillEllipse([System.Drawing.Brushes]::White, 49, 73, 14, 14)    # Layer 4 Aggregator (56, 80)
$g.FillEllipse([System.Drawing.Brushes]::White, 49, 97, 14, 14)    # Layer 5 Actor (56, 104)

$g.Dispose()
$outPath = Join-Path $PSScriptRoot '..' 'resources' 'moa-icon.png'
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK: $outPath"


