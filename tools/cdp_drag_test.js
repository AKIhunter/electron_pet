'use strict';
/* CDP 输入驱动：通过 Chromium 输入管线注入真实合成事件（与真实鼠标同路径）。
 * press -> 6 步微移(跨 6px 阈值) -> 停留 900ms -> release。
 * 主进程跟随器读真实光标，本脚本不动真实光标。
 * 运行: node tools/cdp_drag_test.js
 */
const PORT = 9223;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url));
  if (!page) { console.error('PAGE-NOT-FOUND', list.map((t) => t.url)); process.exit(1); }
  console.log('target:', page.url);

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

  const mouse = (type, x, y, buttons) => send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons, clickCount: 1,
  });

  console.log('press @ (128,128)');
  await mouse('mousePressed', 128, 128, 1);
  await sleep(80);

  for (let i = 1; i <= 6; i++) {
    await mouse('mouseMoved', 128 - 4 * i, 128 - 2 * i, 1);
    await sleep(60);
  }

  console.log('hold 900ms (主进程跟随器运行中...)');
  await sleep(900);

  console.log('release');
  await mouse('mouseReleased', 104, 116, 0);
  await sleep(700);

  ws.close();
  console.log('CDP-DONE');
}

main().catch((e) => { console.error('CDP-ERROR', e.message || e); process.exit(1); });
