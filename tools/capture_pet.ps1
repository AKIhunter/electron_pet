# 按宠物窗口实际位置截屏（支持负坐标副屏）
param([int]$Pad = 40)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
}
"@
$proc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Host "WINDOW-NOT-FOUND"; exit 1 }
$r = New-Object W32+R
[W32]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$w = $r.Rt - $r.L; $h = $r.B - $r.T
$x = $r.L - $Pad / 2; $y = $r.T - $Pad / 2
$size = $w + $Pad
Write-Host ("pet=({0},{1}) {2}x{3}  capture=({4},{5}) {6}x{7}" -f $r.L, $r.T, $w, $h, $x, $y, $size, $size)
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen([int]$x, [int]$y, 0, 0, $bmp.Size)
$g.Dispose()
$out = "e:\Trae_Project\stitch_pet_electron\verify\pet_live.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "saved $out"
