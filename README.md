# 史迪奇桌面宠物（Electron 版）

一个基于 Electron 的透明无边框桌面宠物，行为逻辑采用优先级状态机。本版本相比旧版 PySide6 实现：**删除了摸头交互**，换用了新的动画帧序列，并新增托盘与**可管理的定时提醒面板**。

## 功能

| 交互 | 触发 | 说明 |
|---|---|---|
| 待机 | 默认循环 | **待机1/待机2 两套动画随机交替**，循环播放 |
| 挥手打招呼 | **鼠标左键单击宠物** | 一次性播放，冷却 1200ms |
| 跑开奔跑 | **在宠物窗口内划动，累计位移约 200px 即触发**（一次划过/来回均可） | 宠物**朝远离光标方向跑开约 400px**（1.6s 缓动位移 + 奔跑动画），冷却 1s；撞屏边自动换向；**向左跑自动水平镜像奔跑帧**（素材脸朝右） |
| 审阅思考 | 右键单击 / **办公软件前台活跃** | 右键：审阅1/审阅2 随机二选一；**审阅动画完整播完后冷却 20s**（右键与办公氛围共用，被拖拽/跑开/挥手打断不消耗冷却）；办公软件前台时进入审阅氛围，**播完一次冷却 20s 后自动重播**，切走自动回待机 |
| 抓起拖拽 | 左键按住并拖动 | 最高优先级、不可被打断，跟手移动；**抓起动画播完定格末帧**，松手回落 |
| 摸头 | —— | **已删除** |

行为优先级：**抓起 > 挥手 > 审阅 > 奔跑 > 待机**（高优先级可打断低优先级；抓起不可被打断）。跑开为受惊反应，**可打断审阅/挥手**；各交互结束后统一经 `settle()` 回落——办公活跃则回审阅（氛围保持），否则回待机。

**尺寸**：非奔跑动作以 **0.75 倍**显示（渲染层缩放，见 `pet.js ACTION_VISUAL`；idle2 带 0.9867 等高系数消除两套素材交替跳动）；奔跑保持 1 倍（逃跑瞬间"变大"的戏剧效果）。

**托盘**：通知区史迪奇图标（**裁掉透明边后内容撑满**，更清晰），菜单含 培养手册 / 控制面板 / 显示隐藏宠物 / 退出。

**控制面板**（原提醒面板）：可从托盘或右键菜单打开；工具栏含 **📖 培养手册**（动作触发条件速览）与 **⬇ 下载崩溃日志**；添加带时间的提醒，到点后**系统原生通知 + 宠物头上冒文字泡泡**；提醒持久化到本地（`userdata/reminders.json`），一次性触发后自动移除。底部**版本栏**：显示当前版本 + **⟳ 检查更新**（发现新版本出现「下载并重启」按钮，实时进度见右侧状态，详见下文「自动更新」）。

**崩溃日志**：主进程未捕获异常/未处理 Promise 拒绝/渲染进程崩溃均写入 `userdata/crash/crash-YYYYMMDD.log`（渲染崩溃自动 reload 复活）。存在未下载的崩溃记录时：下次启动宠物头顶弹气泡提示（12s），控制面板"下载崩溃日志"按钮右侧亮**红点**；点击下载（另存为合并日志）成功后红点消失，取消则保留。

## 参数修改速查表（★ 想调行为看这里）

> 代码中所有可自行修改的参数都用 `★` 注释标记，改完**重启应用**生效。

| 想改什么 | 去哪里改 | 默认值 |
|---|---|---|
| 宠物整体大小 | `config.json` → `displayScale`（窗口边长 = 256 × 此值） | 1（=256px） |
| 挥手播放速度 | `renderer/pet.js` → `BEHAVIORS.wave.frameIntervalMs` | 85ms/帧 |
| 待机/审阅/奔跑/抓起 播放速度 | `renderer/pet.js` → `BEHAVIORS` 各项 `frameIntervalMs` | 66/40/55/100 |
| 动作优先级 / 循环与否 | `renderer/pet.js` → `BEHAVIORS` 各项 `priority` / `loops` | drag(4)>wave(3)>review(2)>run(1)>idle(0) |
| 单击挥手冷却 | `renderer/pet.js` → `COOLDOWN.wave` | 1200ms |
| 审阅动画冷却（右键+办公氛围共用） | `renderer/pet.js` → `COOLDOWN.review`（锚点=完整播完时刻，被打断不消耗；办公氛围冷却期由恢复定时器到期自动重播） | 20000ms |
| 拖拽判定阈值（移动多远算拖拽） | `renderer/pet.js` → `INTERACTION.dragThreshold` | 6px |
| 跑开距离 / 时长 | `config.json` → `interaction.fleeDistancePx` / `fleeDurationMs` | 400px / 1600ms |
| 快扫触发灵敏度 | `config.json` → `interaction.swipeTravelPx`（窗内累计位移阈值，越小越灵敏）/ `swipeGapMs`（采样超时清零） | 200px / 250ms |
| 两次跑开最小间隔 | `config.json` → `interaction.fleeCooldownMs` | 1000ms |
| 触发审阅氛围的软件 | `config.json` → `office.processNames`（进程名小写，如加自用软件） | excel/winword/wps/et/wpp 等 |
| 办公监视轮询间隔 | `office-watch.ps1` → 底部 `Start-Sleep -Milliseconds 600` | 600ms |
| 跑开距屏幕边缘余量 / 最小有效位移 | `flee.js` → `EDGE_MARGIN` / `MIN_EFFECTIVE` | 10px / 120px |
| 各动作显示大小 | `renderer/pet.js` → `ACTION_VISUAL`（run=1，其余 0.75；idle2 含等高系数） | 0.75 倍 |
| 启动时出现位置（右下角边距） | `main.js` → `createPetWindow()` 中 `60 / 40` | 右 60px、下 40px |
| 拖拽跟随平滑度 | `main.js` → `registerIpc()` 中跟随定时器 `16`（ms） | 16ms |
| 提醒气泡样式（位置/宽度/配色） | `renderer/style.css` → `#bubble` 段 | — |
| 气泡显示时长 | `renderer/pet.js` → `showBubble()` 默认参数 `6000`（崩溃提示 12000） | 6000ms |
| 控制面板尺寸 | `main.js` → `openReminderWindow()` 中 `360 / 575` | 360×575 |
| 培养手册尺寸 | `main.js` → `openManualWindow()` 中 `500 / 640` | 500×640 |
| 提醒检查间隔 | `main.js` → `CHECK_INTERVAL` | 1000ms |
| 托盘图标尺寸 | `main.js` → `TRAY_ICON_SIZE`（裁透明边后缩放） | 64px |
| 托盘菜单 / 右键菜单 | `main.js` → `createTray()` / `registerIpc()` 内 Menu 模板 | — |
| 托盘提示文字 | `config.json` → `tray.tooltip` | 史迪奇桌面宠物 |
| 自动更新仓库 / 下载代理 | `config.json` → `update` 段（repoOwner / repoName / proxyUrl / exeName） | AKIhunter / electron_pet、http://127.0.0.1:7890 |

> ⚠ 注意：`config.json` 中的 `behaviors`、`cooldowns`、`interaction.dragThreshold` 目前为**参考值**（渲染层未读取），动作帧率/优先级/冷却/拖拽阈值的**实际生效位置是 `renderer/pet.js` 顶部的 `BEHAVIORS` / `COOLDOWN` / `INTERACTION`**。

## 显示尺寸

窗口大小 = `frameCanvas(256) × displayScale`，当前 `displayScale: 1` 即 **256×256（0.5 倍）**，角色高约 190px。改 `config.json` 的 `displayScale` 可整体缩放。

## 运行

```powershell
cd e:\Trae_Project\stitch_pet_electron
npm install
npm start
```

> 提示：如 `npm install` 下载 electron 二进制失败（GitHub 被墙），先设置镜像再安装：
> ```powershell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm install
> ```
> 若报 `The "file" argument must be of type string. Received undefined`，是环境缺少 COMSPEC，补上即可：
> ```powershell
> $env:COMSPEC="C:\Windows\System32\cmd.exe"
> ```

退出：托盘图标右键 → 退出。

## 打包发布（便携 zip）

```powershell
$env:COMSPEC="C:\Windows\System32\cmd.exe"    # 沙盒环境必需（npm 生命周期脚本需要）
$env:ELECTRON_CACHE="e:\Trae_Project\.ebcache\electron"  # 受限环境默认缓存目录不可写时改指可写目录
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run build
```

产物：`dist/electron_pet-v<版本>-win-x64.exe`——**NSIS 一键安装包**（双击即装到 `%LOCALAPPDATA%\Programs\electron_pet`，自动建桌面/开始菜单快捷方式；更新时下载新安装包覆盖安装，安装目录记录在注册表）。应用图标由 `python tools/make_icon.py` 生成 `build/icon.ico`（取待机第 1 帧裁透明边方形化，electron-builder 自动拾取）。

## 自动更新

控制面板底部版本栏点 **⟳ 检查更新** → 主进程请求 GitHub `releases/latest`（`api.github.com` 直连）→ 与本地版本逐段比较：

- **无新版**：显示「已是最新（vX.Y.Z）」。
- **有新版**：出现 **⬇ 下载并重启** → curl 下载 exe 安装包（**代理优先**：先走 `config.update.proxyUrl`（默认本机 Clash 7890），代理不可用秒退自动改直连；**慢速熔断**：连接被限速成 <10KB/s 假连接时 30s 中止换链路；500ms 轮询临时文件大小算百分比）→ 静默运行安装器（`/S` + detached 脱离应用进程树）→ 应用退出，NSIS 安装器自动覆盖安装到原目录并完成升级。

限制：仅 NSIS 安装包形态支持；开发模式（npm start）只能检查不能安装。排障日志：`%TEMP%\electron_pet_update.log`。

## 项目结构

```
stitch_pet_electron/
├── main.js               # 主进程：透明置顶窗口 / 托盘 / IPC / 跑开监视与位移 / 办公前台监视 / 提醒管理器 / 崩溃日志
├── updater.js            # 自动更新（GitHub Release 检查 / 下载 exe 安装包覆盖安装）
├── flee.js               # 跑开位移数学 + SwipeAccumulator 快扫累计器（纯函数，可离线单测）
├── office-watch.ps1      # 前台窗口监视子进程（PowerShell，前台进程变更时输出一行）
├── preload.js            # contextBridge 安全桥
├── config.json           # 行为/帧率/优先级/碰撞/冷却/跑开/办公清单/自动更新等可调参数
├── build/icon.ico        # 应用图标（tools/make_icon.py 生成，electron-builder 打包拾取）
├── renderer/
│   ├── index.html        # 宠物窗口
│   ├── pet.js            # 行为状态机 + 帧循环 + 交互 + 动作缩放/镜像
│   ├── manual.html       # 培养手册（自包含静态页：动作触发条件速览）
│   ├── shield.html/js    # 拖拽事件盾（全屏透明，转发窗口外松手；启动预创建复用）
│   └── style.css
├── reminder/             # 控制面板（html/js/css：提醒 + 培养手册/崩溃日志工具栏）
├── assets/               # 处理后的透明帧，按动作分子目录
│   ├── idle1/ idle2/ wave/ run/ drag/ review1/ review2/
│   ├── meta.json         # 各动作帧数等元数据（渲染层按真实帧数播放）
│   └── _preview.png      # 七宫格透明预览
├── raw/                  # 原始素材解压目录
├── userdata/             # userData（含 reminders.json 与 crash/ 崩溃日志，沙盒环境可写）
└── tools/
    ├── make_icon.py       # 应用图标生成（idle1 第 1 帧 → 多尺寸 icon.ico）
    ├── preprocess.py      # 素材预处理（去背景 + 固定变换归一化到 256×256 透明画布）
    ├── verify_frames.py   # 帧稳定性校验（帧数/位置抖动统计 + run 序列拼图）
    ├── capture_shots.ps1  # 运行时截屏（验证动画推进）
    ├── compare_shots.py   # 截图差分比对
    ├── assert_drag.js     # 拖拽/交互/办公氛围/定格末帧/镜像离线断言（vm 沙箱跑 pet.js）
    ├── assert_panel.js    # 控制面板红点/下载/手册按钮离线断言（vm 沙箱跑 reminder.js）
    ├── test_flee.js       # 跑开位移数学 + SwipeAccumulator 单元测试（flee.js 纯函数）
    ├── cdp_verify.js      # CDP 端到端（气泡/缩放/定格/50 连点压测/帧完整性）
    ├── cdp_diag.js        # 定时器节流诊断（拖拽期间采样帧序列）
    ├── verify_interactions.js # CDP 端到端（单击挥手 + 办公审阅氛围实测）
    ├── cdp_drag_test.js   # 拖拽链路实测（CDP 注入输入，验证 start/move/end 全链路）
    └── win_state.ps1      # 宠物窗口/光标位置读取
```

## 重新生成素材

```powershell
python tools/preprocess.py
```
将 `raw/<动作>/` 下的帧序列去背景并归一化到统一 `256×256` 透明画布。**同一动作内所有帧共用固定 scale + 固定平移**（union bbox 底部中心对齐画布锚点），帧间零相对位移——源动画的逐帧运动被原样保留，杜绝逐帧独立归一化造成的缩放脉动（旧版奔跑失真的根因）。绿残留两级处理：**强绿剔除**（g 同时超过 r+40 与 b+40 视为绿幕，从前景 mask 剔除后再取最大连通域，切断脚下绿幕与角色的连通）+ **despill**（轻度绿溢出把 g 压回 max(r,b)）。各动作帧数：run 30（奔跑2）/ idle1 37 / idle2 37 / review1 63 / review2 37 / wave 13 / drag 5。

## 技术说明

- 透明置顶窗口：`BrowserWindow` + `transparent` + `frame:false` + `alwaysOnTop:'floating'` + `skipTaskbar`。
- 帧动画：主进程读 `assets/meta.json` 经 `assets:meta` IPC 提供各动作真实帧数，渲染层逐帧推进整段序列（idle 两套随机交替、非循环动作播完回落待机）。
- 拖拽：Pointer Events 超过 6px 阈值进入抓起动画；渲染层**只发起止信号**（`pet:dragStart` / `pet:dragEnd`），窗口由主进程以**绝对定位跟随**——拖拽开始记录固定抓取偏移 `offset = 光标 − 窗口左上角`，之后每 16ms 将窗口设为 `光标 − offset`。绝对定位从数学上消除累计误差（旧版按 clientX 增量计算，窗口自移动导致基准漂移，出现"越拖距离越远 + 来回修正颤抖"两个 bug）。启动时预载全部 222 帧，拖拽换帧零闪烁。
- 拖拽事件盾：**启动时预创建一次**、拖拽期间 `show/hide` 复用的全屏透明置顶窗口（`screen-saver` 层级，高于宠物），保证**光标滑出宠物窗口后松手**时 mouseup 一定被盾牌接收并转发 `dragEnd`，跟随器不会黏住鼠标（旧实现每次拖拽新建/销毁全屏透明窗口，Windows 透明合成偶发毛刺——正是"单击后概率性消失"的可疑路径之一）；渲染层 `setPointerCapture` + `pointercancel` + 幂等 `drag-end` 回调多重兜底。
- **动画全速播放**：宠物窗口必须 `webPreferences.backgroundThrottling: false`——Windows 上透明置顶窗口会被 Chromium 遮挡追踪误判为"隐藏页"（`document.visibilityState=hidden`），帧动画 setInterval 被节流到 ~1Hz（动画卡成幻灯片、抓起动画长时间停在第 2 帧）。
- 跑开：主进程 40ms 轮询真实光标，`SwipeAccumulator`（flee.js 纯类）累计**窗口内**光标位移，≥ `swipeTravelPx`(200px) 即触发（一次划过/来回均可；出窗或采样间隔超 `swipeGapMs`(250ms) 清零，防慢速漂移误触；旧实现要求单个 40ms 采样 ≥60px ≈ 1500px/s，一次 200px 划过仅 ~53px/样本，导致"要来回划 3 次"）；方向 = 远离光标（`flee.js` 纯函数：光标→宠物中心延伸，撞工作区边缘自动在 反向/左右转 90° 候选中换向，整窗收边含 10px 边距），**目标在窗口左侧时随 `pet:flee` 附带 `{left:true}`，渲染层将奔跑帧 `scaleX(-1)` 水平镜像**（素材脸朝右）；渲染层收 `pet:flee` 直接进入奔跑动画（有意绕过优先级打断审阅/挥手），主进程 16ms 定时器以 easeOutCubic 将窗口缓动至目标（1.6s ≈ 奔跑一个完整循环），结束后发 `pet:flee-end` 回落。冷却 1s 在主进程侧；run 的 maxMs 3200 兜底 flee-end 丢失。拖拽可随时中止逃跑（`pet:dragStart` 中 abortFlee）。
- 抓起定格末帧：`BEHAVIORS.drag` 为非循环 + `holdLast`，`tick()` 播完置 `frameIdx = frameCount-1` 持续重绘末帧，松手/pointercancel 才 `settle()` 回落。
- 动作缩放：渲染层 `ACTION_VISUAL` 表按动作施加 CSS `scale`（run 1.0、其余 0.75、idle2 ×0.9867 等高），配 `#sprite { transform-origin: 50% 100% }` 底部中心锚定——缩放/换素材时脚不动、向上缩放，消除待机交替跳动；窗口/碰撞箱/拖拽偏移数学全不变。
- 单击消失防御（三重）：盾牌预创建复用（消除透明窗口创建/销毁毛刺）+ 渲染崩溃自动 reload 复活（`render-process-gone` → 记录 + `webContents.reload()`）+ 越界看门狗（3s 检查窗口矩形与所有显示器 workArea 无交集时拉回主屏右下角）。
- 崩溃日志：`uncaughtException` / `unhandledRejection` / 各窗口 `render-process-gone` 三挂接 → 同步写 `userdata/crash/crash-YYYYMMDD.log`（JSONL）+ `pending.json` 未下载标记；主进程崩溃**记录不退出**（桌宠尽力自愈）；下次启动 1.5s 后 pending>0 → 宠物气泡提示 12s；控制面板 `crash:status` 查询红点、`crash:download` 合并全部日志弹另存为（默认名 `史迪奇崩溃日志-YYYYMMDD.txt`），写入成功仅删 pending 标记（日志文件保留，可重复下载）。
- 办公审阅：Electron 无跨应用前台窗口 API，由主进程 spawn 常驻 `office-watch.ps1`（user32 `GetForegroundWindow` → `GetWindowThreadProcessId` → `Get-Process`，600ms 轮询，前台进程变更时输出一行小写进程名），Node readline 逐行匹配 `config.office.processNames`（excel/winword/powerpnt/onenote/outlook/wps/et/wpp，可配置）；前台为宠物自身（electron）时忽略不改状态。渲染层 `settle()` 统一裁决回落：办公活跃 → 审阅（**完整播完后冷却 `COOLDOWN.review`=20s，冷却期回待机、由恢复定时器到期自动重播；被拖拽/跑开/挥手打断不消耗冷却，打断结束立即回审阅**），否则待机。子进程失败静默降级，`will-quit` 时清理。
- 注意：CDP 合成事件不移动真实 OS 光标，跑开监视的主进程路径无法自动化驱动——位移数学由 `tools/test_flee.js` 离线单测覆盖，渲染层响应由 `tools/assert_drag.js` 覆盖，端到端用 `tools/verify_interactions.js`（临时把 notepad 加入办公清单实测氛围进出）。
- userData：开发模式（npm start）指向项目内 `userdata/`（受限/沙盒环境无法写 %APPDATA%）；打包版用系统默认 `%APPDATA%\<应用名>`。
- 提醒：`setInterval` 每秒检查，直达 `Notification` + IPC 气泡（气泡位于窗口内部顶部，不会被透明窗口裁剪）。