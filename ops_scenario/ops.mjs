#!/usr/bin/env node
/**
 * 运维场景：账号未同步排查
 *
 * 按用户给的真实流程实现，并**明确标出每一步是代码还是模型**：
 *   代码 = 确定性分支/字符串比较/日期比较/计数
 *   模型 = 只有四处：读详情字段(字段名可能变)、名字同一性判断
 *
 * 跑 6 个分支变体，输出每条走了哪个结论、几步、几次模型调用、多少钱。
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.HOME + '/.cache/puppeteer/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell'
const PORT = 9225
const PERCEIVE = readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')
const SiteA = 'file://' + join(HERE, 'mock_sitea.html')
const SiteB = 'file://' + join(HERE, 'mock_siteb.html')

const API = 'https://api.deepseek.com/v1/chat/completions'
const KEY = readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)[1]
const PRICE = { miss: 0.15, hit: 0.003, out: 0.60 }

/* ===== 工单里给的信息 ===== */
const EMP = { name: '张三', id: '123', email: '123@123.com' }

/* ===== 场景变体 ===== */
const SCENARIOS = [
  { key: 'A', siteaV: 'user_problem', sitebV: 'ok',  desc: '工号能搜到' },
  { key: 'B', siteaV: 'empty_id',     sitebV: 'ok',  desc: '邮箱搜到, 工号为空' },
  { key: 'C', siteaV: 'dup_email',    sitebV: 'ok',  desc: '邮箱搜到, 是别人(重名)' },
  { key: 'D', siteaV: 'notfound',     sitebV: 'ok',  desc: '两边都没有, SiteB 邮箱对且今天更新' },
  { key: 'E', siteaV: 'notfound',     sitebV: 'stale', desc: '两边都没有, SiteB 邮箱不对' },
  { key: 'F', siteaV: 'notfound',     sitebV: 'old', desc: '两边都没有, SiteB 邮箱对但更新时间不是今天' },
]

/* ============================ CDP ============================ */
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); ws.onerror = () => reject(new Error('ws error'))
      ws.onopen = () => {
        const c = new CDP(ws)
        ws.onmessage = ev => {
          let m; try { m = JSON.parse(ev.data) } catch { return }
          const p = m.id && c.pending.get(m.id); if (!p) return
          c.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
        }
        resolve(c)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error('CDP 超时 ' + method)) }, 20000)
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v) }, reject: e => { clearTimeout(t); reject(e) } })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(e) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
}
const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ============================ 模型调用（只在这几处用） ============================ */
const meter = { calls: 0, ms: 0, cost: 0, ptok: 0, ctok: 0, byStep: [] }
async function model(sys, user, label) {
  const t0 = performance.now()
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0 }),
  })
  const ms = performance.now() - t0
  const d = await r.json()
  if (!r.ok || d.error) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(d.error || d))
  const u = d.usage || {}
  const cost = (u.prompt_cache_miss_tokens || 0) / 1e6 * PRICE.miss + (u.prompt_cache_hit_tokens || 0) / 1e6 * PRICE.hit + (u.completion_tokens || 0) / 1e6 * PRICE.out
  meter.calls++; meter.ms += ms; meter.cost += cost; meter.ptok += u.prompt_tokens; meter.ctok += u.completion_tokens
  meter.byStep.push({ label, ms: Math.round(ms), cost })
  return { json: JSON.parse(d.choices[0].message.content), ms, u, cost }
}

const SYS_EXTRACT = `你是信息抽取器。只输出 JSON, 不解释。
输入是一段界面详情面板的文字。把其中出现的字段抽出来。
字段名可能与你要找的不同(例如「员工编号」=「工号」, 「邮箱地址」=「邮箱」, 「最后更新」=「信息更新时间」)。
找不到的字段, 值给 null。值必须逐字来自原文, 不要改写、不要补全。
输出: {"<字段名>": "<值或null>", ...}`

const SYS_SAME = `你是判断器。只输出 JSON。
判断两个姓名是否指向同一个人。注意: 简繁体、空格、英文名与中文名、同音字都算不同写法但可能是同一人。
证据不足时给低置信度, 不要硬判。
输出: {"same": true|false, "conf": <0~1>, "why": "<一句话>"}`

/* ============================ 页面操作（全部是代码） ============================ */
const fill = (sel, v) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'NOEL';e.value=${JSON.stringify(v)};e.dispatchEvent(new Event('input',{bubbles:true}));return 'OK'})()`
const click = sel => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return 'NOEL';e.click();return 'OK'})()`
const countRows = `document.querySelectorAll('#rows tr, #result table tbody tr').length`
const rowCount = `(()=>{ if(document.querySelector('#result .empty')) return 0; return document.querySelectorAll('#result table tbody tr').length })()`

/* ============================ 主流程 ============================ */
async function goto(cdp, url) {
  await cdp.send('Page.navigate', { url })
  for (let i = 0; i < 40; i++) { await sleep(100); if (await cdp.eval('document.readyState') === 'complete') break }
  await sleep(250)
}
const panelText = st => st.dialogs.join(' \n ')

async function runScenario(cdp, sc) {
  const log = []
  const step = (who, what) => log.push(`[${who}] ${what}`)

  /* ---------- 步骤 1: SiteA 全部成员 ---------- */
  await goto(cdp, SiteA + '?v=' + sc.siteaV)
  step('代码', '打开 SiteA 全部成员页')

  // 1a 搜工号
  await cdp.eval(fill('#kw', EMP.id)); await cdp.eval(click('#go')); await sleep(200)
  let n = await cdp.eval(rowCount)
  step('代码', `搜索框输入工号 ${EMP.id} → 命中 ${n} 条`)
  if (n > 0) {
    step('代码', '分支: 工号能搜到 ⇒ 账号已在 SiteA 中')
    return { problem: '用户自身问题', detail: '工号存在 ⇒ 不是同步问题，是用户操作/权限问题', log }
  }

  // 1b 搜邮箱
  await cdp.eval(fill('#kw', EMP.email)); await cdp.eval(click('#go')); await sleep(200)
  n = await cdp.eval(rowCount)
  step('代码', `改搜邮箱 ${EMP.email} → 命中 ${n} 条`)

  if (n > 0) {
    await cdp.eval(click('.detail')); await sleep(250)
    const st = JSON.parse(await cdp.eval(PERCEIVE))
    const txt = panelText(st)
    step('模型', '读详情面板字段（字段名可能叫「员工编号」等）')
    const ex = await model(SYS_EXTRACT, `【详情面板文字】\n${txt}\n\n【要抽取的字段】工号 / 姓名 / 邮箱`, 'SiteA读详情')
    const empId = ex.json['工号'], name = ex.json['姓名']
    step('代码', `得到 工号=${JSON.stringify(empId)}  姓名=${JSON.stringify(name)}`)

    if (empId === null || empId === '' ) {
      step('代码', '分支: 工号为空')
      return { problem: '问题1', detail: '工号为空 ⇒ 需要运维手动更新', log }
    }
    step('模型', '判断详情里的姓名与工单姓名是否同一人')
    const same = await model(SYS_SAME, `姓名一: ${JSON.stringify(name)}\n姓名二: ${JSON.stringify(EMP.name)}`, 'SiteA名字比对')
    step('代码', `same=${same.json.same} (conf ${same.json.conf})`)
    if (!same.json.same) {
      step('代码', '分支: 邮箱搜到的人不是本人')
      return { problem: '问题2', detail: `邮箱重名 ⇒ ${EMP.email} 属于 ${name}，不是 ${EMP.name}`, log }
    }
    step('代码', '⚠ 落到未定义分支')
    return { problem: '⚠ 未定义', detail: '邮箱搜到、工号非空、姓名相同 —— 你的流程没写这种情况该返回什么', log }
  }

  /* ---------- 步骤 2: SiteB 组织用户管理 ---------- */
  step('代码', 'SiteA 两边都搜不到 ⇒ 进入第二步 SiteB')
  await goto(cdp, SiteB + '?v=' + sc.sitebV)
  await cdp.eval(click('#login')); await sleep(200)
  await cdp.eval(`(()=>{const s=document.getElementById('loginType');s.value='用户名';s.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await cdp.eval(fill('#loginId', EMP.id))
  await cdp.eval(click('#doLogin')); await sleep(250)
  step('代码', `点登陆 → 选择用户名 → 输入工号 ${EMP.id} → 确定`)

  const hasRow = await cdp.eval(`document.querySelector('#rows #detail') ? 'Y':'N'`)
  if (hasRow !== 'Y') { step('代码', '分支: SiteB 也查不到'); return { problem: '⚠ 未定义', detail: 'SiteB 也查不到该工号', log } }
  await cdp.eval(click('#detail')); await sleep(250)

  const st2 = JSON.parse(await cdp.eval(PERCEIVE))
  step('模型', '读 SiteB 详情字段（邮箱 / 信息更新时间）')
  const ex2 = await model(SYS_EXTRACT, `【详情面板文字】\n${panelText(st2)}\n\n【要抽取的字段】邮箱 / 信息更新时间`, 'SiteB读详情')
  const email = ex2.json['邮箱'], upd = ex2.json['信息更新时间']
  step('代码', `得到 邮箱=${JSON.stringify(email)}  信息更新时间=${JSON.stringify(upd)}`)

  if (String(email || '').toLowerCase().trim() !== EMP.email.toLowerCase()) {
    step('代码', '分支: 邮箱不一致')
    return { problem: '问题3', detail: `SiteB 邮箱=${email} ≠ ${EMP.email} ⇒ 邮箱还未更新，上游系统问题`, log }
  }
  if (isToday(upd)) {
    step('代码', '分支: 邮箱正确 且 更新时间是今天')
    return { problem: '正常', detail: '邮箱已正确，更新时间为今天 ⇒ 系统间更新间隔一天，等明天再看', log }
  }
  step('代码', '⚠ 落到未定义分支')
  return { problem: '⚠ 未定义', detail: `邮箱正确但更新时间=${upd}（不是今天）—— 你的流程没写这种情况`, log }
}

function isToday(s) {
  if (!s) return false
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return false
  const d = new Date(), t = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${m[1]}-${m[2]}-${m[3]}` === t
}

/* ============================ 跑全部变体 ============================ */
const chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(HERE, '.chrome'), 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore'] })

let cdp
try {
  let page = null
  for (let i = 0; i < 40 && !page; i++) { await sleep(300); try { page = (await getJSON('/json/list')).find(t => t.type === 'page') } catch {} }
  if (!page) throw new Error('Chrome 未就绪')
  cdp = await CDP.connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')

  const results = []
  for (const sc of SCENARIOS) {
    meter.calls = 0; meter.ms = 0; meter.cost = 0; meter.ptok = 0; meter.ctok = 0; meter.byStep = []
    const t0 = performance.now()
    let r
    try { r = await runScenario(cdp, sc) } catch (e) { r = { problem: '💥 异常', detail: e.message, log: [] } }
    const wall = performance.now() - t0
    results.push({ ...sc, ...r, wall, m: { ...meter } })

    console.log('\n' + '═'.repeat(96))
    console.log(`场景 ${sc.key}: ${sc.desc}`)
    console.log('─'.repeat(96))
    for (const l of r.log) console.log('  ' + l)
    console.log('─'.repeat(96))
    console.log(`  ▶ 结论: ${r.problem}  ——  ${r.detail}`)
    console.log(`  ▶ 墙钟 ${(wall / 1000).toFixed(2)}s | 模型 ${meter.calls} 次 ${meter.ms.toFixed(0)}ms | $${meter.cost.toFixed(6)} | in ${meter.ptok} out ${meter.ctok}`)
  }

  console.log('\n' + '═'.repeat(96))
  console.log('汇总')
  console.log('─'.repeat(96))
  console.log('场景 | 输入                | 结论        | 模型调用 | 墙钟   | 花费')
  for (const r of results) {
    console.log(`${r.key}    | ${r.desc.padEnd(20)}| ${r.problem.padEnd(11)} | ${String(r.m.calls).padEnd(8)} | ${(r.wall / 1000).toFixed(2)}s  | $${r.m.cost.toFixed(6)}`)
  }
  const tot = results.reduce((a, r) => a + r.m.cost, 0)
  const totMs = results.reduce((a, r) => a + r.wall, 0)
  console.log('─'.repeat(96))
  console.log(`6 个分支合计: ${(totMs / 1000).toFixed(1)}s  $${tot.toFixed(6)}  ≈ $${(tot / 6 * 1000).toFixed(3)} / 1000 次排查`)
  console.log(`模型调用于整条流程的占比: 每个场景 ${results.map(r => r.m.calls).join('/')} 次`)
  console.log('═'.repeat(96))
} finally {
  try { cdp?.ws.close() } catch {}
  chrome.kill('SIGKILL')
}
