# 输出宠物窗口位置与真实光标位置
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }
}
"@
$proc = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) { Write-Host "WINDOW-NOT-FOUND"; exit 1 }
$r = New-Object W32+R
[W32]::GetWindowRect($proc.MainWindowHandle, [ref]$r) | Out-Null
$p = New-Object W32+P
[W32]::GetCursorPos([ref]$p) | Out-Null
Write-Host ("win=({0},{1})-({2},{3}) cursor=({4},{5})" -f $r.L, $r.T, $r.Rt, $r.B, $p.X, $p.Y)
