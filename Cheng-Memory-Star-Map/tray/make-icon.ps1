Add-Type -AssemblyName System.Drawing

# 生成托盘图标：橙色底 + 白色「澄」字
# 输出 16/32/48/256 四种尺寸，打包成 .ico

$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$icoPath = Join-Path $outDir 'starmap.ico'

function New-Icon-Bitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic

    # 橙色渐变圆底
    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 255, 168, 64),
        [System.Drawing.Color]::FromArgb(255, 232, 122, 26),
        45.0)
    $g.FillEllipse($brush, 0, 0, $size - 1, $size - 1)
    $brush.Dispose()

    # 白色「澄」字
    $fs = [Math]::Max(6, [int]($size * 0.68))
    $font = New-Object System.Drawing.Font('Microsoft YaHei', $fs,
        [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

    $textRect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $g.DrawString('澄', $font, [System.Drawing.Brushes]::White, $textRect, $sf)

    $font.Dispose()
    $g.Dispose()
    return $bmp
}

# 各尺寸 PNG 数据
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) {
    $bmp = New-Icon-Bitmap $s
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,@($s, $ms.ToArray())
    $bmp.Dispose()
    $ms.Dispose()
}

# 手写 ICO 容器（PNG 压缩格式，Vista+ 支持）
$fsOut = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fsOut

$count = $pngs.Count
$bw.Write([UInt16]0)          # reserved
$bw.Write([UInt16]1)          # type = icon
$bw.Write([UInt16]$count)     # count

$offset = 6 + $count * 16
foreach ($p in $pngs) {
    $size = $p[0]
    $data = $p[1]
    $dim = if ($size -ge 256) { 0 } else { $size }
    $bw.Write([byte]$dim)          # width
    $bw.Write([byte]$dim)          # height
    $bw.Write([byte]0)             # palette
    $bw.Write([byte]0)             # reserved
    $bw.Write([UInt16]1)           # color planes
    $bw.Write([UInt16]32)          # bits per pixel
    $bw.Write([UInt32]$data.Length)
    $bw.Write([UInt32]$offset)
    $offset += $data.Length
}
foreach ($p in $pngs) {
    $bw.Write($p[1])
}
$bw.Flush()
$bw.Close()
$fsOut.Close()

# 顺便存一张 256 的 PNG 预览
$bmp = New-Icon-Bitmap 256
$bmp.Save((Join-Path $outDir 'starmap-preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output "已生成：$icoPath"
Write-Output "预览：$(Join-Path $outDir 'starmap-preview.png')"
Write-Output "大小：$((Get-Item $icoPath).Length) bytes"
