#!/usr/bin/env node
/**
 * 两阶段浏览器 Computer Use
 *
 *   阶段一 System 2 (deepseek-v4-pro)  每个任务一次：
 *       读【工单 JSON + 完整候选表(100+)】→ 产出计划：
 *         - openElement  先点哪个
 *         - keepIds/keepLabels  候选白名单（把 100+ 收敛到 ≤20）
 *         - fieldMap     表单字段 → 值（这就是"工单→表单映射"）
 *         - avoidLabels  禁止触碰
 *   阶段二 System 1 (deepseek-flash)  每步一次：
 *       在收缩后的候选集上做 choice/noul，代码执行、代码校验
 *   失败 → 把失败轨迹喂回 System 2 反思重规划（最多 REFLECT 次）
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.HOME + '/.cache/puppeteer/chrome-headless-shell/linux-152.0.7977.75/chrome-headless-shell-linux64/chrome-headless-shell'
const PORT = 9224
const APP = 'file://' + join(HERE, 'app2.html')
const PERCEIVE = readFileSync(join(HERE, 'perceive.js'), 'utf8')

const API = 'https://api.deepseek.com/v1/chat/completions'
const KEY = readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)[1]
const P = {
  flash: { miss: 0.15, hit: 0.003, out: 0.60 },
  pro: { miss: 0.66, hit: 0.022, out: 1.98 },
  jevIn: 0.042,
}
const MAX_STEPS = Number(process.env.MAX_STEPS || 10)
const REFLECT = Number(process.env.REFLECT || 2)
const CONF_HARD_FLOOR = Number(process.env.CONF_HARD || 0.15) // 低于此 = 模型明确"不知道"，才升级给人
const CONF_VERIFY = Number(process.env.CONF_VERIFY || 0.60)   // 低于此 = 照常执行，但强制比对界面是否变化
const KEEP_MAX = Number(process.env.KEEP_MAX || 20)
const DANGER = ['删除', '移除', '清空', '支付', '付款', '购买', '转账', '退出登录', '注销']

/* -------- 工单数据（真实系统里来自 API/DB） -------- */
const TICKET = {
  id: '1042', title: '登录页报错', assignee: '李娜', priority: 'P1', status: '处理中',
  description: "用户反馈登录接口在 token 过期后未刷新。复现: 打开登录页 → 等待 30 分钟 → 点击提交。控制台报 Uncaught TypeError: Cannot read property 'id' of undefined",
}
const GOAL = `在工单列表里找到 #${TICKET.id}，打开它的编辑面板，按工单内容把表单填好并保存，最后提交。
注意: 列表里每个工单都有「编辑」按钮，必须选 #${TICKET.id} 那一行的。`

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
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('页面异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    return r.result.value
  }
}
const getJSON = path => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej)
})
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ============================ 调模型 ============================ */
async function callModel({ model, sys, user, price, label }) {
  const t0 = performance.now()
  const r = await fetch(API, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0 }),
  })
  const ms = performance.now() - t0
  const d = await r.json()
  if (!r.ok || d.error) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(d.error || d))
  const u = d.usage || {}
  const cost = (u.prompt_cache_miss_tokens || 0) / 1e6 * price.miss + (u.prompt_cache_hit_tokens || 0) / 1e6 * price.hit + (u.completion_tokens || 0) / 1e6 * price.out
  return { ms, u, cost, json: JSON.parse(d.choices[0].message.content), label }
}

/* ============================ System 2：规划 ============================ */
const S2_SYS = `你是桌面自动化任务的规划器(System 2)。你只输出 JSON，不输出任何解释文字。

你的输入是:
  1. 一个目标
  2. 一份结构化的工单数据(字段名是英文/系统的)
  3. 当前页面的【完整候选元素表】，每个元素有编号、类型、名称、文字、当前值、所在行上下文、是否可用

你要输出一个计划 JSON:
{
  "openElement": "<先点哪个候选元素的编号；若无需先点则 null>",
  "keepIds": ["<按重要性从高到低排序的候选编号，最多 15 个>"],
  "keepLabels": ["<需要保留的控件名关键词，如 经办人/优先级/标题/备注/保存/提交/确认提交>"],
  "fieldMap": { "<表单上显示的字段名>": "<要填入的值>" },
  "avoidLabels": ["<绝对不能点的控件名关键词>"],
  "plan": ["<步骤1>", "<步骤2>"],
  "reason": "<一句话>"
}

关键要求:
- fieldMap 的键必须与候选表里控件的 **name 字段逐字一致**(那是表单上真实的字段标签)。
- 工单数据的字段名与表单字段名可能不一致(例如 assignee 对应「经办人」)，值域也可能不一致
  (例如 priority=P1 而表单只提供 低/中/高)，你要做出正确的语义映射与值转换。
- 若某个表单字段在工单数据里没有直接对应值，就从描述里提炼一个合适的短文本。
- avoidLabels 必须包含所有破坏性操作(删除/批量删除/退出登录等)。
- keepIds 最多 15 个，按重要性排序。执行阶段【只会看到这 15 个】，所以凡完成任务所需的控件
  都必须出现在里面，一个都不能漏(例如: 目标那一行的编辑按钮、保存、提交、确认提交)。宁可多放几个。
- keepLabels 是补充匹配用的关键词，可以留空。`

function s2Prompt(st, ticket, goal, fail, reachNote) {
  const L = []
  L.push('【目标】', goal, '')
  L.push('【工单数据】', JSON.stringify(ticket, null, 1), '')
  L.push('【页面】', (st.title || '') + '  ' + (st.url || ''))
  if (st.dialogs.length) L.push('当前有打开的面板/弹窗: ' + st.dialogs.join(' | '))
  L.push('')
  L.push(`【完整候选元素表】共 ${st.candidates.length} 个`)
  for (const c of st.candidates) {
    const b = [`[${c.id}]`, c.kind]
    if (c.name) b.push('name="' + c.name + '"')
    if (c.text && c.text !== c.name) b.push('文字="' + c.text + '"')
    if (c.value) b.push('值=' + c.value)
    if (c.ctx) b.push('行="' + c.ctx + '"')
    if (!c.enabled) b.push('【禁用】')
    L.push(b.join('  '))
  }
  if (reachNote) { L.push(''); L.push('【硬约束】' + reachNote) }
  if (fail) {
    L.push('')
    L.push('【上一次计划失败了，这是失败轨迹，请修正计划】')
    L.push(fail)
  }
  return L.join('\n')
}

/* ============================ System 1：执行 ============================ */
const S1_SYS = [
  '你是 System One —— 只做决策、不产出文本的判断模型。',
  '输出: 严格 JSON, 内含每题所有选项的分数。',
  '',
  '决策原语:',
  '- choice: 从 N 个互斥选项里选一个 -> 给每个选项一个相对分数',
  '- noul:   是/否判断 -> 给 {"yes": 分数} / {"no": 分数}',
  '',
  '铁律:',
  '1. 只输出 JSON, 不解释、不加代码围栏。',
  '2. 分数必须覆盖全部选项, 键名与选项标签逐字一致。',
  '3. 分数是相对权重, 不必凑成 1.0。',
  '4. 置信度必须诚实: 证据弱就摊开, 不要一律 0.99。',
  '5. 情景是唯一事实来源。',
  '6. 多题独立作答, 互不参照。',
  '',
  '规则:',
  '- 候选编号只在当前这一轮快照里有效, 只从给定编号里选。',
  '- 「可用=否」表示控件被禁用, 点了没效果。',
  '- 若目标控件在一个尚未打开的面板里, 先选能打开它的元素。',
  '',
  '输出格式:',
  '{"answers":[{"id":"<题号>","type":"choice|noul","probs":{"<标签>":<数字>,...},"best":"<标签>","conf":<数字>}]}',
].join('\n')

function s1Prompt(st, goal, plan, triedDead, prog) {
  const L = []
  L.push('【目标】', goal, '')
  L.push('【计划(仅供参考，不得违反)】', (plan.plan || []).join(' → '))
  L.push('【绝不允许触碰】', (plan.avoidLabels || []).join(' / ') || '(无)')
  if (prog) {
    L.push('')
    L.push('【进度 · 代码已判定，以此为准，不要重复已完成的事】')
    for (const r of prog.rows) L.push('  ' + (r.done ? '✅' : '⬜') + ' ' + r.what)
    L.push(prog.pending.length
      ? '  ▶ 下一步必须处理: ' + prog.pending.join(' / ')
      : (prog.open ? '  ▶ 字段都填好了 → 接下来该点保存/提交' : '  ▶ 先打开编辑面板'))
  }
  if (triedDead && triedDead.length) L.push('【已尝试过且界面没有任何变化，不要再选】', [...new Set(triedDead)].join(' / '))
  L.push('')
  L.push('【当前状态】')
  L.push('状态: ' + (st.status.join(' | ') || '(无)'))
  if (st.fields.length) L.push('字段: ' + st.fields.map(f => `${f.name}=${f.value || '(空)'}`).join('  '))
  if (st.alerts.length) L.push('提示: ' + st.alerts.join(' | '))
  L.push('面板/弹窗: ' + (st.dialogs.length ? st.dialogs.join(' | ') : '(无)'))
  L.push('')
  L.push('【候选元素】(已按计划收缩, 编号仅本轮有效)')
  for (const c of st.candidates) {
    const b = [`[${c.id}]`, c.kind]
    if (c.name) b.push('"' + c.name + '"')
    if (c.text && c.text !== c.name) b.push('文字="' + c.text + '"')
    if (c.value) b.push('当前值=' + c.value)
    if (c.ctx) b.push('行="' + c.ctx + '"')
    b.push('可用=' + (c.enabled ? '是' : '否'))
    L.push(b.join('  '))
  }
  L.push('')
  L.push('【问题】(两题独立)')
  L.push('id=q1, type=choice: 下一步应该操作哪个候选元素?  【选项】 ' + st.candidates.map(c => c.id).join(' / '))
  L.push('id=q2, type=noul: 目标是否已经全部完成?  【选项】 yes / no')
  return L.join('\n')
}

/* ============================ 执行 ============================ */
const actExpr = (id, snap, fieldMap) => `(() => {
  const el = document.querySelector('[data-jev="' + ${JSON.stringify(id)} + '"]');
  if (!el) return JSON.stringify({ ok:false, why:'元素不存在(快照过期)' });
  if (el.getAttribute('data-jev-snap') !== ${JSON.stringify(snap)}) return JSON.stringify({ ok:false, why:'快照编号过期' });
  if (el.disabled) return JSON.stringify({ ok:false, why:'元素被禁用' });
  const label = (el.getAttribute('aria-label') || (el.id && document.querySelector('label[for="'+el.id+'"]')?.textContent) || '').trim();
  const FM = ${JSON.stringify(fieldMap)};
  const target = FM[label];
  const tag = el.tagName.toLowerCase();
  if (tag === 'select' || tag === 'input' || tag === 'textarea') {
    if (!target) return JSON.stringify({ ok:false, why:'该控件不在 fieldMap 里: [' + label + ']' });
    el.value = target;
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
    return JSON.stringify({ ok:true, did:'fill ' + label + ' = ' + target });
  }
  el.click();
  return JSON.stringify({ ok:true, did:'click ' + (label || el.innerText || el.value || tag) });
})()`

// 每步候选视图的优先级：打开的对话框内 > 表单控件 > 命中计划关键词 > 计划点名的编号
function prioritize(cands, plan, keepIds) {
  const labs = plan.keepLabels || []
  const named = new Set(plan.keepIds || [])
  const score = c => {
    let v = 0
    if (c.zone === 'panel') v += 100
    if (/^(select|input|textarea)/.test(c.kind)) v += 50
    if (labs.some(k => k && (c.name + ' ' + c.text).includes(k))) v += 20
    if (named.has(c.id) || (keepIds && keepIds.has(c.id))) v += 10
    if (c.ctx && /编辑/.test(c.text || '')) v += 5
    return v
  }
  return cands.map(c => ({ c, v: score(c) })).sort((a, b) => b.v - a.v).map(x => x.c)
}

// 代码侧进度台账：把"还差什么"算出来，模型只负责"这件事由哪个元素完成"
function progress(st, plan) {
  const fm = plan.fieldMap || {}
  const open = st.dialogs.length > 0
  const rows = [{ done: open, what: '编辑面板已打开' }]
  const pending = []
  for (const field of Object.keys(fm)) {
    const f = st.fields.find(x => x.name === field)
    if (!f) { rows.push({ done: false, what: field + '(当前不可见)' }); pending.push(field); continue }
    const done = String(f.value) === String(fm[field])
    rows.push({ done, what: field + ': 当前=' + (f.value || '(空)') + ' 目标=' + fm[field] })
    if (!done) pending.push(field)
  }
  return { open, rows, pending }
}

const fingerprint = st => JSON.stringify({ s: st.status, f: st.fields, a: st.alerts, d: st.dialogs,
  c: st.candidates.map(c => c.id + ':' + (c.value || '') + (c.enabled ? '1' : '0')) })

/* ============================ 主流程 ============================ */
const chrome = spawn(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(HERE, '.chrome2'), APP], { stdio: ['ignore', 'ignore', 'ignore'] })

const stats = { s2: [], s1: [], reduced: [], reflect: 0 }
let cdp
try {
  let page = null
  for (let i = 0; i < 40 && !page; i++) {
    await sleep(300)
    try { page = (await getJSON('/json/list')).find(t => t.type === 'page' && t.url.startsWith('file://')) } catch {}
  }
  if (!page) throw new Error('找不到页面 target')
  cdp = await CDP.connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await sleep(700)

  console.log('='.repeat(110))
  console.log('目标: ' + GOAL.replace(/\n/g, ' '))
  console.log('='.repeat(110))

  const st0 = JSON.parse(await cdp.eval(PERCEIVE))
  console.log(`\n■ 阶段一 · System 2 规划 (deepseek-v4-pro)`)
  console.log(`  原始候选表: ${st0.candidates.length} 个元素`)

  // ---- 确定性前置检查：目标在不在这页上？(不花钱、最先跑) ----
  const targetId = TICKET.id
  const hitRow = st0.candidates.filter(c => (c.ctx || '').includes('#' + targetId))
  const reachable = hitRow.length > 0
  console.log(`  ⚑ 前置检查: 目标 #${targetId} 在本页候选中可见 = ${reachable ? '是 (' + hitRow.length + ' 个相关元素)' : '否'}`)
  if (!reachable) {
    console.log(`  ⛔ 目标不可达 —— 不进入规划，直接要求先搜索/翻页（本次省下 3 次反思与全部执行）`)
  }

  let plan = null, failNote = null, ok = false, lastTrace = [], escalated = false
  for (let attempt = 0; attempt <= REFLECT && !ok; attempt++) {
    const reachNote = reachable ? '' : `注意: 前置检查发现 #${targetId} 当前【不在】候选表里。计划的第一步必须是先让它出现(例如在关键词框输入 ${targetId} 后点查询)。`
    const stNow = attempt === 0 ? st0 : JSON.parse(await cdp.eval(PERCEIVE))
    if (attempt > 0) console.log(`  (反思用新鲜快照: ${stNow.candidates.length} 个元素, 面板=${stNow.dialogs.length ? '已开' : '无'})`)
    const s2 = await callModel({ model: 'deepseek-v4-pro', sys: S2_SYS, user: s2Prompt(stNow, TICKET, GOAL, failNote, reachNote), price: P.pro, label: 'S2' })
    plan = s2.json
    stats.s2.push(s2)
    console.log(`\n  [规划 ${attempt + 1}] ${s2.ms.toFixed(0)}ms  in=${s2.u.prompt_tokens}(hit ${s2.u.prompt_cache_hit_tokens || 0}) out=${s2.u.completion_tokens}  $${s2.cost.toFixed(6)}`)
    console.log(`    openElement = ${plan.openElement}`)
    console.log(`    keepIds     = ${(plan.keepIds || []).join(', ') || '(空)'}`)
    console.log(`    keepLabels  = ${(plan.keepLabels || []).join(' / ')}`)
    console.log(`    fieldMap    = ${JSON.stringify(plan.fieldMap, null, 0)}`)
    console.log(`    avoidLabels = ${(plan.avoidLabels || []).join(' / ')}`)
    console.log(`    plan        = ${(plan.plan || []).join('  →  ')}`)

    // ---- 候选收缩 ----
    const byId = new Map(stNow.candidates.map(c => [c.id, c]))
    const ranked = (plan.keepIds || []).filter(id => byId.has(id)).slice(0, KEEP_MAX).map(id => byId.get(id))
    const keepIdsForView = new Set(plan.keepIds || [])
    const inRank = new Set(ranked.map(c => c.id))
    const labs = plan.keepLabels || []
    const extra = stNow.candidates.filter(c => !inRank.has(c.id) && labs.some(k => k && (c.name + ' ' + c.text + ' ' + c.ctx).includes(k)))
    const keep = c => inRank.has(c.id) || labs.some(k => k && (c.name + ' ' + c.text + ' ' + c.ctx).includes(k))
    // keepIds 供阶段二排序用
    let reduced = [...ranked, ...extra].slice(0, KEEP_MAX)   // 排序在前的一定进得来
    stats.reduced.push({ from: stNow.candidates.length, to: reduced.length })
    console.log(`    ▶ 候选收缩: ${stNow.candidates.length} → ${reduced.length}  (${(100 * reduced.length / stNow.candidates.length).toFixed(1)}%)`)

    // ---- 阶段二 ----
    console.log(`\n■ 阶段二 · System 1 执行 (deepseek-flash, 候选表 ≤${KEEP_MAX})`)
    const trace = []
    const triedDead = []          // 试过但没产生任何变化的动作
    let noopStreak = 0
    for (let step = 1; step <= MAX_STEPS; step++) {
      const st = JSON.parse(await cdp.eval(PERCEIVE))
      if (st.status.includes('已提交')) { ok = true; break }
      const prog = progress(st, plan)
      const dead = new Set(triedDead)
      const doneNames = new Set(prog.rows.filter(r => r.done && /: 当前=/.test(r.what)).map(r => r.what.split(':')[0]))
      let view = prioritize(st.candidates.filter(keep), plan, keepIdsForView)
      const pruned = view.filter(c => !doneNames.has(c.name) && !dead.has(c.name || c.text))
      view = (pruned.length >= 3 ? pruned : view).slice(0, KEEP_MAX)   // 兜底：别把选项删空
      // 保证 openElement 还在视野里
      if (plan.openElement && !view.some(c => c.id === plan.openElement)) {
        const o = st.candidates.find(c => c.id === plan.openElement); if (o) view.push(o)
      }
      const stv = { ...st, candidates: view }

      const d = await callModel({ model: 'deepseek-flash', sys: S1_SYS, user: s1Prompt(stv, GOAL, plan, triedDead, prog), price: P.flash, label: 'S1' })
      stats.s1.push(d)
      const q1 = d.json.answers?.find(a => a.id === 'q1') || {}
      const q2 = d.json.answers?.find(a => a.id === 'q2') || {}
      const conf = Number(q1.conf ?? 0)
      const chosen = view.find(c => c.id === q1.best)
      const desc = chosen ? chosen.kind + ' "' + (chosen.name || chosen.text) + '"' + (chosen.ctx ? ' 行=' + chosen.ctx.slice(0, 30) : '') : '(未找到)'
      console.log(`  [步 ${step}] 候选${String(view.length).padStart(2)} | 选 ${String(q1.best).padEnd(4)} conf=${String(conf).padEnd(4)} | 完成=${q2.best}(${q2.conf}) | ${d.ms.toFixed(0)}ms in=${d.u.prompt_tokens}(hit ${d.u.prompt_cache_hit_tokens || 0}) out=${d.u.completion_tokens} $${d.cost.toFixed(6)}`)
      console.log(`         → ${desc}`)
      trace.push({ step, nCand: view.length, best: q1.best, conf, done: q2.best, picked: desc, ms: Math.round(d.ms), cost: d.cost })

      if (!chosen) { console.log('         ✗ 编号不在候选表内'); continue }
      if (conf < CONF_HARD_FLOOR) { console.log(`         ⛔ conf ${conf} < ${CONF_HARD_FLOOR} —— 模型明确"不知道", 升级给人`); escalated = true; break }
      if (conf < CONF_VERIFY) console.log(`         ↓ conf ${conf} < ${CONF_VERIFY} —— 低置信执行 + 强制比对界面变化`)
      const lbl = (chosen.name || '') + ' ' + (chosen.text || '')
      const avoid = (plan.avoidLabels || []).some(w => lbl.includes(w)) || DANGER.some(w => lbl.includes(w))
      if (avoid) { console.log(`         🛡 危险拦截: ${lbl.trim()}`); break }

      const fpBefore = fingerprint(st)
      const res = JSON.parse(await cdp.eval(actExpr(chosen.id, st.snap, plan.fieldMap || {})))
      console.log('         执行: ' + JSON.stringify(res))
      if (!res.ok) { triedDead.push(chosen.name || chosen.text || chosen.id); continue }
      await sleep(150)
      const after = JSON.parse(await cdp.eval(PERCEIVE))
      const changed = fingerprint(after) !== fpBefore
      console.log('         校验: 状态=' + (after.status.join('/') || '-') + ' | 提示=' + (after.alerts.join(' | ') || '-') +
        ' | 界面变化=' + (changed ? '是' : '否 ⚠空操作'))
      if (!changed) {
        noopStreak++
        triedDead.push(chosen.name || chosen.text || chosen.id)
        if (noopStreak >= 2) { console.log('         ⚠ 连续空操作 —— 判定无进展，提前反思'); break }
      } else {
        noopStreak = 0
        if (/^(select|input|textarea)/.test(chosen.kind)) triedDead.push(chosen.name || chosen.id)
      }
    }
    lastTrace = trace
    if (!ok) {
      stats.reflect++
      failNote = '执行了 ' + trace.length + ' 步仍未完成。轨迹:\n' + trace.map(t =>
        `  步${t.step}: 选了 ${t.best} (${t.picked}) conf=${t.conf}，之后状态未达成`).join('\n')
      console.log('\n  ↩ 未完成 —— 把失败轨迹喂回 System 2 反思重规划')
    }
  }

  const final = JSON.parse(await cdp.eval(PERCEIVE))
  console.log('\n' + '='.repeat(110))
  const s2cost = stats.s2.reduce((a, x) => a + x.cost, 0), s2ms = stats.s2.reduce((a, x) => a + x.ms, 0)
  const s1cost = stats.s1.reduce((a, x) => a + x.cost, 0), s1ms = stats.s1.reduce((a, x) => a + x.ms, 0)
  const s1pt = stats.s1.reduce((a, x) => a + x.u.prompt_tokens, 0)
  const r0 = stats.reduced[0]
  console.log(`候选收缩        : ${r0.from} → ${r0.to}  (${(100 * r0.to / r0.from).toFixed(1)}%)`)
  console.log(`System 2 (v4-pro): ${stats.s2.length} 次 | ${(s2ms / 1000).toFixed(2)}s | $${s2cost.toFixed(6)}`)
  console.log(`System 1 (flash) : ${stats.s1.length} 次 | ${(s1ms / 1000).toFixed(2)}s | $${s1cost.toFixed(6)} | in ${s1pt} tok`)
  console.log(`合计             : ${((s2ms + s1ms) / 1000).toFixed(2)}s | $${(s2cost + s1cost).toFixed(6)}`)
  console.log(`Jev 同 token 估算 : $${(s1pt / 1e6 * P.jevIn).toFixed(6)} (仅 System 1 输入)`)
  console.log(`反思次数         : ${stats.reflect}${escalated ? '  (曾因模型"不知道"升级给人)' : ''}`)
  console.log(`最终状态         : ${final.status.join('/') || '-'}`)
  console.log(`结果             : ${ok ? '✅ 成功' : '❌ 未达成'}`)
  console.log('='.repeat(110))

  writeFileSync(join(HERE, 'plan_trace.json'), JSON.stringify({ goal: GOAL, ticket: TICKET, ok, plan, reduced: stats.reduced, trace: lastTrace, final: final.status }, null, 1))
  console.log('已写入 browser_jev/plan_trace.json')
} finally {
  try { cdp?.ws.close() } catch {}
  chrome.kill('SIGKILL')
}
