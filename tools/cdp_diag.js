'use strict';
/* 诊断：拖拽期间（盾牌显示时）渲染层 setInterval 是否被节流
 * node tools/cdp_diag.js
 */
const PORT = 9223;

async function main() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await r.json();
  const pet = targets.find((t) => t.url.includes('renderer/index.html'));
  if (!pet) { console.error('FAIL: 未找到宠物窗口'); process.exit(1); }
  const ws = new WebSocket(pet.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };

  // 安装节流探针：统计 1s 内 100ms 定时器实际触发次数
  await ev(`(window.__probe = () => new Promise((res) => {
    let n = 0; const t0 = performance.now();
    const id = setInterval(() => {
      n++;
      if (performance.now() - t0 >= 1000) { clearInterval(id); res(n); }
    }, 100);
  }), 'installed')`);

  console.log('盾牌隐藏（无拖拽）时 100ms 定时器 1 秒触发次数:');
  console.log('  →', await ev('window.__probe()'));

  console.log('按下并拖动（盾牌显示）:');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 128, y: 128, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 160, y: 140, button: 'left', buttons: 1 });
  await new Promise((r) => setTimeout(r, 300));
  const frames = [];
  for (let i = 0; i < 10; i++) {
    frames.push(await ev('document.getElementById("sprite").src.match(/frame_(\\d+)/)[1]'));
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log('  拖拽期间每 150ms 采样帧序列:', frames.join(','));
  console.log('  盾牌显示时 100ms 定时器 1 秒触发次数:');
  console.log('  →', await ev('window.__probe()'));

  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 128, y: 138, button: 'left', clickCount: 1 });
  await new Promise((r) => setTimeout(r, 300));
  console.log('松手（盾牌隐藏）后 100ms 定时器 1 秒触发次数:');
  console.log('  →', await ev('window.__probe()'));
  ws.close();
}
main().catch((e) => { console.error('ERROR', e); process.exit(1); });
