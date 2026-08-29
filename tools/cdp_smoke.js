'use strict';
/* 冒烟验证：应用存活 + 动画推进。node tools/cdp_smoke.js */
const PORT = 9223;

async function main() {
  for (let i = 0; i < 10; i++) {
    try { await fetch(`http://127.0.0.1:${PORT}/json`); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 500)); }
  }
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  const targets = await r.json();
  const pet = targets.find((t) => t.url.includes('renderer/index.html'));
  if (!pet) { console.error('no pet target'); process.exit(1); }
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
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  console.log('alive:', (await ev('1+1')) === 2);
  const a = () => ev('document.getElementById("sprite").src');
  console.log('action:', String(await a()).match(/assets\/(\w+)\//)?.[1]);
  const f1 = String(await a()).match(/frame_(\d+)/)?.[1];
  await new Promise((r) => setTimeout(r, 700));
  const f2 = String(await a()).match(/frame_(\d+)/)?.[1];
  console.log('frame advancing:', f1, '->', f2, f1 !== f2);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
