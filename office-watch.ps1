# ============================================================================
# 前台窗口监视（office-watch.ps1，由 main.js startOfficeWatcher 常驻拉起）
# ============================================================================
# 每次前台窗口变化时，向 stdout 输出一行小写进程名（无变化不输出），
# 主进程逐行读取并与 config.json office.processNames 匹配。
# ★ 可调参数：底部 Start-Sleep 的 600（轮询间隔 ms，越小响应越快、耗电略增）
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FGW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint procId);
}
"@
$last = ""
while ($true) {
  try {
    # 取前台窗口句柄 -> 进程 ID -> 进程名
    $h = [FGW]::GetForegroundWindow()
    if ($h -ne [IntPtr]::Zero) {
      $procId = 0
      [FGW]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
      $name = ""
      if ($procId -ne 0) {
        $name = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
      }
      # 仅在前台进程变化时输出一行（进程名含空格属正常，主进程按整行匹配）
      if ($name -and ($name.ToLower() -ne $last)) {
        [Console]::Out.WriteLine($name.ToLower())
        [Console]::Out.Flush()
        $last = $name.ToLower()
      }
    }
  } catch { } # 提权进程取不到名字等情况：跳过本轮
  Start-Sleep -Milliseconds 600 # ★ 轮询间隔 ms
}
