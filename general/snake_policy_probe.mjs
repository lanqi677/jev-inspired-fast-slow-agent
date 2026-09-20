#!/usr/bin/env node
/**
 * 贪吃蛇"策略层"探针 —— 不调任何模型，纯代码在页面里跑完整局。
 *
 * 目的：回答"撞自己到底是**描述没写清**，还是**规则本身不够**"。
 *
 *   做法：把任务描述里那条规则**逐字用代码实现**（= 模型 100% 服从、零误解），
 *         再和"更强的策略"对比。如果连逐字实现都死于一模一样的"撞自己"，
 *         那就证明瓶颈不在描述清不清楚，而在规则本身。
 *
 * 三个策略：
 *   A · 局部安全 + 朝食物          ← task_贪吃蛇-避免撞自己.txt 里那条规则的逐字实现
 *   B · A + 平手时贴住尾巴          ← 只多一条"留退路"的平手规则
 *   C · 安全 + 走完之后可达空格最多  ← 空间管理（需要预判，不能只看一步）
 *
 * 用法：node snake_policy_probe.mjs [--seeds 35749,...] [--port 9500]
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
const SEEDS = opt('--seeds', '35749,83540,28672,11111,22222,33333,44444,55555').split(',').map(s => s.trim()).filter(Boolean)
const PORT = Number(opt('--port', process.env.CDP_PORT || 9500))

const HOME = process.env.HOME || os.homedir()
const CHROME = [
  process.env.CHROME_HEADLESS_BIN, process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  `${HOME}/.cache/puppeteer/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell`,
].filter(Boolean).find(p => existsSync(p))
if (!CHROME) { console.error('找不到 Chrome。用 CHROME_BIN=... 指定。'); process.exit(1) }

const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  }).on('error', rej)
})
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pend = new Map(); let s = 0
    ws.onerror = () => reject(new Error('ws error'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pend.get(m.id); if (!p) return
        pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      resolve({ send: (me, pa = {}) => new Promise((R, J) => {
        const id = ++s; pend.set(id, { resolve: R, reject: J })
        ws.send(JSON.stringify({ id, method: me, params: pa }))
        setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + me)) }, 30000)
      }), close: () => ws.close() })
    }
  })
}

/* ---------- 注入到页面里的策略实现（纯代码，无模型） ---------- */
const SETUP = `
window.__PROBE__ = (() => {
  const DIRS = ['U','D','L','R'];
  const OPP  = { U:'D', D:'U', L:'R', R:'L' };
  const D    = { U:[-1,0], D:[1,0], L:[0,-1], R:[0,1] };

  // 所有"走一步不会当场死"的方向。尾巴这一步会让开，所以撞尾巴不算死（与游戏规则一致）
  function safeMoves(S) {
    const N = S.N, snake = S.snake, dir = S.dir, food = S.food;
    const [hr, hc] = snake[0];
    const bodyOnly = new Set(snake.slice(0, -1).map(p => p[0] + ',' + p[1]));
    const out = [];
    for (const d of DIRS) {
      if (d === OPP[dir]) continue;                       // 反向非法（选项被标 [禁用]）
      const nr = hr + D[d][0], nc = hc + D[d][1];
      if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;   // 撞墙
      if (bodyOnly.has(nr + ',' + nc)) continue;               // 撞到自己
      out.push({ d, nr, nc,
        dist: food ? Math.abs(nr - food[0]) + Math.abs(nc - food[1]) : 0,
        eat: !!(food && food[0] === nr && food[1] === nc) });
    }
    return out;
  }

  // 走完这一步之后，从新蛇头出发能到达的空格数（越大 = 越不容易被围死）
  function freeAfter(mv, S) {
    const N = S.N, snake = S.snake;
    const occupied = new Set(snake.map(p => p[0] + ',' + p[1]));   // 旧头留在原地变成身体
    if (!mv.eat) { const t = snake[snake.length - 1]; occupied.delete(t[0] + ',' + t[1]); }  // 没吃则尾巴让开
    occupied.delete(snake[0][0] + ',' + snake[0][1]);              // 头要移走
    occupied.add(mv.nr + ',' + mv.nc);                             // 头去新位置
    const start = mv.nr + ',' + mv.nc;
    const vis = new Set([start]); let n = 0; const q = [[mv.nr, mv.nc]];
    while (q.length) {
      const [r, c] = q.pop(); n++;
      for (const d of DIRS) {
        const nr = r + D[d][0], nc = c + D[d][1];
        if (nr < 0 || nr >= N || nc < 0 || nc >= N) continue;
        const k = nr + ',' + nc;
        if (vis.has(k) || occupied.has(k)) continue;
        vis.add(k); q.push([nr, nc]);
      }
    }
    return n;
  }

  const tailDist = (mv, S) => { const t = S.snake[S.snake.length - 1]; return Math.abs(mv.nr - t[0]) + Math.abs(mv.nc - t[1]); }

  const POLICIES = {
    // A：task_贪吃蛇-避免撞自己.txt 里那条规则的逐字实现
    A: S => {
      const c = safeMoves(S); if (!c.length) return null;
      c.sort((a, b) => (b.eat - a.eat) || (a.dist - b.dist));
      return c[0].d;
    },
    // B：A + 平手时贴住尾巴（只多一条"留退路"的平手规则）
    B: S => {
      const c = safeMoves(S); if (!c.length) return null;
      c.sort((a, b) => (b.eat - a.eat) || (a.dist - b.dist) || (tailDist(a, S) - tailDist(b, S)));
      return c[0].d;
    },
    // C：安全 + 走完之后可达空格最多（需要预判，不是"只看一步"）
    C: S => {
      const c = safeMoves(S); if (!c.length) return null;
      const eat = c.filter(m => m.eat);
      if (eat.length) return eat[0].d;                       // 能吃就吃
      for (const m of c) m.space = freeAfter(m, S);
      c.sort((a, b) => (b.space - a.space) || (a.dist - b.dist) || (tailDist(a, S) - tailDist(b, S)));
      return c[0].d;
    },
  };

  return {
    run(seed, name) {
      const S = window.SNAKE;
      S.reset(seed);
      const fn = POLICIES[name];
      let guard = 0;
      while (!S.over && guard++ < 3000) {
        const d = fn(S);
        // 四个方向全死 = 被自己围死（真模型这时只能硬选一个，然后报"撞到自己"）
        if (!d) return { reason: '无路可走（被自己围死）', score: S.score, steps: S.steps, trapped: true };
        S.move(d);
      }
      return { reason: S.reason || '超步数', score: S.score, steps: S.steps, trapped: false };
    },
  };
})();
'ok'
`

console.log('Chrome : ' + CHROME)
const chrome = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--headless', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + join(HERE, '.chrome-probe'),
  '--no-first-run', '--no-default-browser-check', 'about:blank'],
{ stdio: ['ignore', 'ignore', 'ignore'] })
const bury = () => { try { chrome.kill('SIGKILL') } catch {} }
process.on('exit', bury)

let cdp = null
const results = []
try {
  let page = null
  for (let i = 0; i < 60 && !page; i++) { await sleep(300); try { page = (await getJSON('/json/list')).find(t => t.type === 'page') } catch {} }
  if (!page) throw new Error('Chrome 未就绪')
  cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  const ev = async e => {
    const r = await cdp.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  const url = 'file:///' + encodeURI(join(HERE, 'games', 'snake.html').replace(/\\/g, '/'))
  await cdp.send('Page.navigate', { url })
  for (let i = 0; i < 80; i++) { await sleep(150); if (await ev('document.readyState') === 'complete') break }
  await sleep(300)
  await ev(SETUP)

  for (const name of ['A', 'B', 'C']) {
    console.log(`\n───── 策略 ${name} ─────`)
    for (const seed of SEEDS) {
      const r = JSON.parse(await ev(`JSON.stringify(window.__PROBE__.run(${seed}, ${JSON.stringify(name)}))`))
      results.push({ policy: name, seed: Number(seed), ...r })
      console.log(`  seed ${String(seed).padEnd(7)} 死于 ${String(r.reason).padEnd(12)} 得分 ${String(r.score).padStart(2)}  步数 ${String(r.steps).padStart(3)}`)
    }
  }
} finally {
  try { cdp?.close() } catch {}
  bury()
}

console.log('\n══════════ 汇总 ══════════')
for (const name of ['A', 'B', 'C']) {
  const rs = results.filter(r => r.policy === name)
  const trap = rs.filter(r => r.trapped).length
  const wall = rs.filter(r => /撞墙/.test(r.reason)).length
  const ok = rs.filter(r => r.score >= 5).length
  const avg = (rs.reduce((a, r) => a + r.score, 0) / rs.length).toFixed(1)
  console.log(`策略 ${name}  n=${rs.length}  被自己围死 ${trap}  撞墙 ${wall}  达标 ${ok}/${rs.length}  平均分 ${avg}`)
}
writeFileSync(join(HERE, 'snake_policy_probe_result.json'),
  JSON.stringify({ ranAt: new Date().toISOString(), seeds: SEEDS, results }, null, 1), 'utf8')
console.log('\n明细已写入 general/snake_policy_probe_result.json')
