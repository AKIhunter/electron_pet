param(
  [int]$Count = 3,
  [int]$IntervalMs = 700,
  [string]$OutDir = "e:\Trae_Project\stitch_pet_electron\verify"
)
# 截取宠物窗口区域（右下角，含余量），用于验证动画推进
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
$wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$win = 256
$pad = 72
$x = $wa.X + $wa.Width - $win - 60 - $pad / 2
$y = $wa.Y + $wa.Height - $win - 40 - $pad / 2
$size = $win + $pad
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host ("region x={0} y={1} size={2} (workArea {3}x{4})" -f [int]$x, [int]$y, $size, $wa.Width, $wa.Height)
for ($i = 1; $i -le $Count; $i++) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$x, [int]$y, 0, 0, $bmp.Size)
  $g.Dispose()
  $p = Join-Path $OutDir ("shot{0}.png" -f $i)
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "saved $p"
  if ($i -lt $Count) { Start-Sleep -Milliseconds $IntervalMs }
}
