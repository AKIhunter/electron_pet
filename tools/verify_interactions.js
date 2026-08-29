'use strict';
/* CDP 端到端验证：办公审阅氛围（notepad 模拟办公软件）+ 单击挥手。
 * 前置：config.json office.processNames 已临时加入 "notepad"；
 *       应用以 --remote-debugging-port=9223 运行。
 * 顺序：先办公测试后点击测试 —— 避免点击使宠物窗口获焦点影响前台判定。
 * 运行: node tools/verify_interactions.js
 */
const { spawn, execSync } = require('child_process');
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await sleep(2500);
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
  if (!page) { console.error('PAGE-NOT-FOUND'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params) => new Promise((res) => {
    const id = nextId++;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true });
  const getSrc = async () => (await evaluate('document.getElementById("sprite").src')).result?.result?.value || '';
  const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });

  async function sample(ms, interval = 120) {
    const seen = [];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const src = await getSrc();
      const m = src.match(/assets\/(\w+)\/frame_(\d+)\.png/);
      if (m && !seen.includes(m[1])) seen.push(m[1]);
      await sleep(interval);
    }
    return seen;
  }
  const isIdle = (acts) => acts.length > 0 && acts.every((a) => a === 'idle1' || a === 'idle2');

  let allOk = true;
  function check(name, ok) {
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
    if (!ok) allOk = false;
  }

  // 1) 基线：待机（当前前台 TRAE，非办公）
  let acts = await sample(1500);
  console.log('基线动作:', acts.join(','));
  check('基线为待机', isIdle(acts));

  // 2) 启动 notepad（新窗口自动前台）-> 审阅氛围（watcher 轮询 600ms）
  const np = spawn('notepad.exe', [], { stdio: 'ignore' });
  await sleep(2600);
  acts = await sample(3200);
  console.log('notepad 前台时动作:', acts.join(','));
  check('办公前台进入审阅', acts.includes('review1') || acts.includes('review2'));

  // 3) 关闭 notepad -> 前台回落非办公 -> 回待机
  try { execSync(`taskkill /PID ${np.pid} /T /F`, { stdio: 'ignore' }); } catch (e) { /* ignore */ }
  await sleep(2600);
  acts = await sample(3200);
  console.log('notepad 关闭后动作:', acts.join(','));
  check('切走回待机', isIdle(acts));

  // 4) 单击 -> 挥手（最后测，避免聚焦影响前台判定）
  await mouse('mousePressed', 128, 128, 1);
  await mouse('mouseReleased', 128, 128, 0);
  acts = await sample(1500);
  console.log('单击后动作:', acts.join(','));
  check('左键单击触发挥手', acts.includes('wave'));

  // 5) 挥手播完回落待机
  await sleep(1100);
  acts = await sample(2500);
  console.log('挥手后回落:', acts.join(','));
  check('挥手播完回待机', isIdle(acts) || (acts.length === 1 && acts[0] === 'wave'));

  ws.close();
  console.log(allOk ? '\nVERIFY-OK' : '\nVERIFY-FAIL');
  process.exit(allOk ? 0 : 1);
}

main().catch((e) => { console.error('ERROR', e.message || e); process.exit(1); });
