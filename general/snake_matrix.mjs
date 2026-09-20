#!/usr/bin/env node
/**
 * 贪吃蛇策略 A/B 回归 —— 同一批随机种子，跑不同的【任务描述】，对比"死于什么"和得分。
 *
 *   只改描述，不改引擎、不改适配器、不改游戏页。这个脚本就是用来证明这一点的。
 *
 * 用法：
 *   node snake_matrix.mjs
 *   node snake_matrix.mjs --seeds 35749,83540 --steps 200
 *   node snake_matrix.mjs --tasks "task_贪吃蛇.txt,task_贪吃蛇-避免撞自己.txt"
 *
 * 环境变量：
 *   CHROME_BIN / CHROME_HEADLESS_BIN   Chrome 可执行文件（不设则按常见路径探测）
 *   HOME                               ~/.dsh/.credentials.yaml 所在的家目录（Windows 上通常需要显式设置）
 *   PORT_BASE                          起始 CDP 端口（默认 9401，每个种子 +1，避免残留端口互相污染）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }

const SEEDS = opt('--seeds', '35749,83540,28672,11111,22222,33333,44444,55555')
  .split(',').map(s => s.trim()).filter(Boolean)
const STEPS = opt('--steps', '200')
const TASKS = opt('--tasks', 'task_贪吃蛇.txt,task_贪吃蛇-避免撞自己.txt')
  .split(',').map(s => s.trim()).filter(Boolean)
const PORT_BASE = Number(opt('--port-base', process.env.PORT_BASE || 9401))

const HOME = process.env.HOME || os.homedir()
const CHROME = [
  process.env.CHROME_HEADLESS_BIN, process.env.CHROME_BIN,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  `${HOME}/.cache/puppeteer/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell`,
  `${HOME}/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome`,
].filter(Boolean).find(p => existsSync(p))

if (!CHROME) { console.error('找不到 Chrome。用 CHROME_BIN=... 指定。'); process.exit(1) }
console.log('Chrome : ' + CHROME)
console.log('HOME   : ' + HOME)

const SNAKE_URL = 'file:///' + encodeURI(join(HERE, 'games', 'snake.html').replace(/\\/g, '/'))

function playOne(task, seed, port) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['engine.mjs'], {
    cwd: HERE,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    env: {
      ...process.env,
      HOME,
      CHROME_BIN: CHROME,
      CHROME_HEADLESS_BIN: CHROME,
      ADAPTER: 'snake',
      TASK_FILE: task,
      CDP_PORT: String(port),
      START_URL: `${SNAKE_URL}?seed=${seed}`,
      MAX_STEPS: String(STEPS),
    },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const concl = (out.match(/▶ 结论: (.*)/) || [])[1] || ''
  const cost = (out.match(/▶ 模型 (\d+) 次\s+\$([\d.]+)/) || [])
  return {
    task, seed, port,
    sec: +((Date.now() - t0) / 1000).toFixed(1),
    died: /撞到自己/.test(concl) ? '撞自己'
      : /撞墙/.test(concl) ? '撞墙'
      : /超步数/.test(concl) ? '超步数'
      : concl ? '其它' : '无结论',
    score: Number((concl.match(/score (\d+)/) || [])[1] ?? NaN),
    reached: /✓ 达成目标/.test(concl),
    calls: cost[1] ? Number(cost[1]) : NaN,
    usd: cost[2] ? Number(cost[2]) : NaN,
    conclusion: concl,
    raw: r.error ? String(r.error) : '',
  }
}

const results = []
for (const task of TASKS) {
  console.log(`\n══════════ ${task} ══════════`)
  for (let i = 0; i < SEEDS.length; i++) {
    const port = PORT_BASE + i
    const one = playOne(task, SEEDS[i], port)
    results.push(one)
    console.log(`  seed ${String(one.seed).padEnd(7)} ${String(one.sec + 's').padEnd(7)} 死于 ${one.died.padEnd(4)} 得分 ${one.score}  达成=${one.reached ? '✓' : '✗'}  $${one.usd}`)
    if (one.raw) console.log('     ' + one.raw.slice(0, 200))
  }
}

console.log('\n══════════ 汇总 ══════════')
for (const task of TASKS) {
  const rs = results.filter(r => r.task === task)
  const self = rs.filter(r => r.died === '撞自己').length
  const wall = rs.filter(r => r.died === '撞墙').length
  const ok = rs.filter(r => r.reached).length
  const avg = (rs.reduce((a, r) => a + (r.score || 0), 0) / rs.length).toFixed(1)
  const usd = rs.reduce((a, r) => a + (r.usd || 0), 0).toFixed(4)
  console.log(`${task.padEnd(34)} n=${rs.length}  撞自己 ${self}  撞墙 ${wall}  达标 ${ok}/${rs.length}  平均分 ${avg}  花费 $${usd}`)
}

writeFileSync(join(HERE, 'snake_matrix_result.json'), JSON.stringify({
  ranAt: new Date().toISOString(), chrome: CHROME, steps: STEPS, seeds: SEEDS, results,
}, null, 1), 'utf8')
console.log('\n明细已写入 general/snake_matrix_result.json')
