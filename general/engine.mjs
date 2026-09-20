#!/usr/bin/env node
/**
 * 通用任务执行引擎（描述驱动，不改代码）
 *
 *   你写的：一段自然语言任务描述
 *   引擎里的固定部分（跨任务不变）：
 *     ① System 2 拆解 →  事实(facts) + 分支规则(rules) + 动作序列(actions)   ← 规则变成【数据】
 *     ② 每个动作：System 1 在候选元素里【选】谁来做  ← 界面变了也不用改代码
 *     ③ 代码：按编号执行、算事实、判规则、安全拦截
 *     ④ 失败 → 回 System 2 修
 *
 * 动作词表: goto / fill / click / select / wait
 * 事实种类: rowCount(代码) / extract(模型抽取) / sameName(模型判断) / today(代码)
 * 规则比较: > < == != isEmpty isToday contains
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { loadAdapter, describeAdapter, perceiveExpr, countExpr, textExpr, extractByAdapter, fieldRegex, executeExpr, waitSpec, listAdapters, resolveMock } from './adapter.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// BROWSER=headless（默认）| headed   —— headed 会开一个真实窗口，可随时最小化
const HEADED = /headed|head|visible|gui/i.test(process.env.BROWSER || '')
// Chrome 路径：换设备/换版本都不用改代码，用 CHROME_BIN / CHROME_VERSION 覆盖即可
const CHROME_VERSION = process.env.CHROME_VERSION || '152.0.7977.75'
const CACHE = (process.env.HOME || '') + '/.cache/puppeteer'
const CHROME = (HEADED
  ? (process.env.CHROME_BIN || process.env.CHROME_HEADED_BIN)
  : (process.env.CHROME_HEADLESS_BIN || process.env.CHROME_BIN))
  || (HEADED
    ? `${CACHE}/chrome/linux-${CHROME_VERSION}/chrome-linux64/chrome`
    : `${CACHE}/chrome-headless-shell/linux-${CHROME_VERSION}/chrome-headless-shell-linux64/chrome-headless-shell`)
const PORT = Number(process.env.CDP_PORT || 9226)

/* ---- 适配器：站点/环境专有的东西全在这里，引擎本体不含一行 ---- */
const PERCEIVE_SRC = readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')
const ADAPTER = loadAdapter(process.env.ADAPTER)          // 不设 = 通用启发式
const PERCEIVE = perceiveExpr(ADAPTER, PERCEIVE_SRC)
const ADAPTER_COUNT = countExpr(ADAPTER)                  // 结果条数：代码算，不调模型
const TEXTE = textExpr(ADAPTER)                           // 抽取字段时的文字作用域
const GUARD_BLOCK = ADAPTER?.guards?.off ? [] : (ADAPTER?.guards?.block || ['删除', '移除', '注销', '退出登录', '支付', '转账'])
const API = 'https://api.deepseek.com/v1/chat/completions'
const KEY = readFileSync(process.env.HOME + '/.dsh/.credentials.yaml', 'utf8').match(/DEEPSEEK_API_KEY\s*:\s*(\S+)/)[1]
const P = { flash: { miss: 0.15, hit: 0.003, out: 0.60 }, pro: { miss: 0.66, hit: 0.022, out: 1.98 } }
const meter = { calls: 0, cost: 0, ms: 0, log: [] }

/* ============================ CDP ============================ */
class CDP {
  constructor(ws) { this.ws = ws; this.seq = 0; this.pending = new Map() }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); ws.onerror = () => reject(new Error('ws error'))
      ws.onopen = () => {
        const c = new CDP(ws)
        ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
          const p = m.id && c.pending.get(m.id); if (!p) return
          c.pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
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

/* ============================ 模型 ============================ */
async function call(model, sys, user, tier) {
  const t0 = performance.now()
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0 }) })
  const ms = performance.now() - t0
  const d = await r.json()
  if (!r.ok || d.error) throw new Error('HTTP ' + r.status + ' ' + JSON.stringify(d.error || d))
  const u = d.usage || {}
  const pr = P[tier]
  const cost = (u.prompt_cache_miss_tokens || 0) / 1e6 * pr.miss + (u.prompt_cache_hit_tokens || 0) / 1e6 * pr.hit + (u.completion_tokens || 0) / 1e6 * pr.out
  meter.calls++; meter.cost += cost; meter.ms += ms
  return { json: JSON.parse(d.choices[0].message.content), ms, u, cost }
}

/* ============================ 页面状态 → 文本 ============================ */
const aId = (plan, ref) => (plan.facts || []).some(f => f.id === ref) ? ref
  : ((plan.facts || []).find(f => f.name === ref) || {}).id
// 一条规则依赖哪些事实：when.fact + 事实自身引用的上游事实
function ruleFacts(rl, plan) {
  const out = [rl.when.fact]
  const byId = Object.fromEntries((plan.facts || []).map(f => [f.id, f]))
  const walk = id => {
    const f = byId[id]; if (!f) return
    for (const key of ['of', 'a', 'b']) {
      if (f[key]) { const up = aId(plan, f[key]); if (up && !out.includes(up)) { out.push(up); walk(up) } }
    }
  }
  walk(rl.when.fact)
  return out
}
let facts = {}, ready = new Set()
let PLAN = null
let CDP_CONN = null

// 递归补齐上游事实，再采集；同一事实只采一次
async function snapshotFacts(ids) {
  const byId = Object.fromEntries((PLAN.facts || []).map(f => [f.id, f]))
  const want = [], seen = new Set()
  const add = id => {
    const f = byId[id]; if (!f || ready.has(id) || seen.has(id)) return
    seen.add(id)
    for (const k of ['of', 'a', 'b']) { const up = aId(PLAN, f[k]); if (up) add(up) }
    want.push(id)
  }
  ids.forEach(add)
  if (!want.length) return

  // 抽取类：适配器有正则的走代码（零模型调用），其余的才交给模型
  const ex = want.map(i => byId[i]).filter(f => f.kind === 'extract')
  if (ex.length) {
    const txt = await CDP_CONN.eval(TEXTE)
    const byAdapter = ex.filter(f => fieldRegex(ADAPTER, f.name))
    const byModel = ex.filter(f => !fieldRegex(ADAPTER, f.name))
    for (const f of byAdapter) {
      const o = extractByAdapter(ADAPTER, f.name, txt)
      if (o.ok) { facts[f.id] = o.value; ready.add(f.id); console.log(`        (适配器抽取「${f.name}」= ${JSON.stringify(o.value)}  ← 0 次模型调用)`) }
      else console.log(`        (适配器抽取「${f.name}」未命中: ${o.reason})`)
    }
    if (byModel.length) {
      const r = await call('deepseek-flash', extractSys(),
        `【界面文字】\n${txt}\n\n【要抽取的字段】\n` + byModel.map(f => `- ${f.name}`).join('\n'), 'flash')
      for (const f of byModel) {
        const o = (r.json.values || {})[f.name]
        if (o && o.found) { facts[f.id] = o.value; ready.add(f.id) }
        else console.log(`        (字段「${f.name}」在本页未出现，事实 ${f.id} 保持未就绪)`)
      }
    }
  }
  // 其余种类
  for (const id of want) {
    const f = byId[id]; if (!f || ready.has(id)) continue
    if (f.kind === 'rowCount') { facts[id] = await CDP_CONN.eval(ADAPTER_COUNT || ROWCOUNT); ready.add(id) }
    else if (f.kind === 'today') {
      const up = aId(PLAN, f.of)
      if (up && ready.has(up)) { facts[id] = isToday(facts[up]); ready.add(id) }
    } else if (f.kind === 'sameName') {
      const ia = aId(PLAN, f.a), ib = aId(PLAN, f.b)
      const okA = ia ? ready.has(ia) : true, okB = ib ? ready.has(ib) : true
      if (okA && okB) {
        const va = ia ? facts[ia] : f.a, vb = ib ? facts[ib] : f.b
        const r = await sameName(va, vb)
        facts[id] = r.same; ready.add(id)
        console.log(`        (同名判断: ${JSON.stringify(va)} vs ${JSON.stringify(vb)} → ${r.same} conf=${r.conf})`)
      }
    }
  }
}

const st2text = st => {
  const L = ['页面: ' + (st.title || '') + '  ' + (st.url || '')]
  if (st.count !== undefined && st.count !== null) L.push('结果计数(适配器算): ' + st.count)
  L.push('状态区: ' + (st.status.join(' | ') || '(无)'))
  if (st.fields.length) L.push('表单: ' + st.fields.map(f => `${f.name}=${f.value || '(空)'}`).join('  '))
  if (st.alerts.length) L.push('提示: ' + st.alerts.join(' | '))
  L.push('面板/弹窗: ' + (st.dialogs.length ? st.dialogs.join(' | ') : '(无)'))
  L.push('可见文本片段: ' + st.candidates.map(c => c.ctx || c.text).filter(Boolean).slice(0, 12).join(' ¶ ').slice(0, 400))
  return L.join('\n')
}
const cand2text = cs => cs.map(c => {
  const b = [`[${c.id}]`, c.kind]
  if (c.name) b.push('"' + c.name + '"')
  if (c.text && c.text !== c.name) b.push('文字="' + c.text + '"')
  if (c.value) b.push('值=' + c.value)
  if (c.ctx) b.push('行="' + c.ctx + '"')
  if (c.zone === 'panel') b.push('[面板内]')
  if (!c.enabled) b.push('[禁用]')
  return b.join('  ')
}).join('\n')

/* ============================ System 2：拆解任务 ============================ */
const S2_SYS = `你是浏览器自动化任务的拆解器。只输出 JSON，不解释。

把自然语言任务拆成三样东西：
  facts   需要从页面读出来的事实（注意: 它反映的是"某一刻"的状态，靠 actions 的 snapshot 定点采集）
  rules   分支规则（有序，先匹配先返回）
  actions 要执行的动作序列（有序）

【动作词表】只能用它，不要发明
  {"do":"goto","url":"..."}
  {"do":"fill","target":"<用自然语言描述目标控件>","text":"<要填的内容，可用 {{变量}}>"}
  {"do":"click","target":"<自然语言描述>"}
  {"do":"select","target":"<自然语言描述>","option":"<选项文字>"}
  {"do":"wait","ms":800}
  ★ 动作只有这 5 种。【没有 "snapshot" 这个动作】—— 采集事实是在某个动作上挂 "snapshot" 字段，
    写成 {"do":"snapshot"} 是错的：那个事实永远不会被采集，引用它的规则永远不会命中。
可选字段 "unless":["r1","r2"]  表示这些规则一旦成立就跳过本动作。
可选字段 "snapshot":["f1","f3"]  【非常重要】表示执行完这个动作后，把这几个事实【采集并冻结】。
   事实反映的是"那一刻"的页面状态。同一个事实只会在它第一次被 snapshot 时采集一次，
   之后不再重算。所以:
     - 「第一次搜索后的结果条数」要在【那次搜索】的动作上 snapshot f1;
     - 「第二次搜索后的结果条数」要在【第二次搜索】的动作上 snapshot f2 —— 必须分开两次采!
     - 「详情面板里的某个字段」要在【点完查看详情】那个动作上 snapshot。
   漏了 snapshot 的事实永远不会被采集，引用它的规则也永远不会命中。

【事实种类】只能用它
  {"id":"f1","kind":"rowCount","desc":"..."}
  {"id":"f2","kind":"extract","name":"<字段名>","desc":"..."}       读页面/面板上的某个字段值
  {"id":"f3","kind":"sameName","a":"<字段名或{{变量}}>","b":"<字段名或{{变量}}>","desc":"..."}
  {"id":"f4","kind":"today","of":"<字段名>","desc":"..."}

【规则】固定形状
  {"id":"r1","when":{"fact":"f1","op":">","value":0},"conclusion":"<返回给用户的结论>","stop":true}
  重要: stop:true 只能用在【最终要返回给用户的结论】上。
        中间跳转(例如"进入下一步""继续查看详情")的 stop 必须是 false。
        任务描述里每一个"结束"对应一条 stop:true 的规则，必须覆盖全。
  op 可用: > < >= <= == != isEmpty !isEmpty isToday contains
  结论要写成给运维看的完整中文句子。

输出 JSON:
{"goal":"<复述目标>","facts":[...],"rules":[...],"actions":[...],"notes":"<可选>"}

要求:
- actions 要完整覆盖到达每个分支所需的所有操作。有分支的地方用 unless 跳过不需要的。
- target 一律用界面上的中文文字描述（如"搜索框""登陆按钮""查看详情按钮"），不要写 CSS 选择器——
  执行阶段会自己去页面上找。
- 凡任务描述里给出的具体字面值，原样写进 text / b，不要改写。`

function s2user(task, st, failNote) {
  return ['【任务描述】', task, '', '【当前页面】', st2text(st), '',
    '【可交互元素】', cand2text(st.candidates.slice(0, 60)),
    failNote ? '\n【上一次执行失败的轨迹，请修正】\n' + failNote : ''].join('\n')
}

/* ============================ System 1：选元素 / 判断 ============================ */
const S1_SYS = `你是决策器。只输出 JSON。
决策原语:
 - choice: 从候选里选一个 -> 给每个候选一个相对分数(不必和为1)
 - noul:   是/否 -> {"yes":分数} / {"no":分数}
置信度要诚实: 不确定就把分数摊开。
输出: {"answers":[{"id":"q1","type":"choice|noul","probs":{...},"best":"...","conf":0.9}]}`

/* 动作 → 合法元素类型。
 * 代码把关"只能在这一类里选"，模型只管"选哪一个"。
 * 没有这道闸，模型偶尔会把「搜索框」选成「搜索按钮」，引擎对着按钮 fill 还返回 OK ——
 * 查询根本没发生，事实却照采，最后走进完全错误的分支。这类失败是无声的，必须结构性拦掉。 */
const FIT = {
  fill: c => /^(input|textarea)/.test(c.kind) && c.enabled !== false,
  select: c => c.kind === 'select' || /^input/.test(c.kind),
  click: () => true,
  press: () => true,
}

async function findElement(desc, st, tried, act) {
  const all = st.candidates
  const fit = FIT[act?.do]
  const cs = fit ? all.filter(fit) : all
  if (!cs.length) return { id: null, why: `页面没有能「${act?.do}」的元素（候选 ${all.length} 个，类型都不符）` }
  const u = ['【当前页面】', st2text(st), '', '【候选元素】(编号仅本轮有效)', cand2text(cs), '',
    '【问题】', `id=q1, type=choice: 要完成「${desc}」，应该【${act.do}】哪个候选元素?  【选项】 ${cs.map(c => c.id).join(' / ')}`]
  if (tried && tried.length) u.push(`注意: ${tried.join('、')} 已经试过但界面没有任何变化，不要重复选。`)
  const r = await call('deepseek-flash', S1_SYS, u.join('\n'), 'flash')
  const a = r.json.answers?.[0] || {}
  return { id: a.best, conf: a.conf, why: `conf=${a.conf}`, ms: r.ms }
}

const EXTRACT_SYS = `你是信息抽取器，只输出 JSON，不解释。
判断每个字段【的标签是否出现在】这段界面文字里。
关键: 「标签出现了、但后面没有值」→ found 给 true, value 给空字符串 ""。
      「标签完全没出现」→ 只有这种情况才给 found: false。
      这两种情况绝不能混: 前者表示"字段存在且为空", 后者表示"页面上没有这个字段"。
字段名可能不同名。已知的别名会单独列出；没列出的就靠语义判断。
界面上根本没有这个字段时 found 给 false。绝不改写、绝不补全、绝不用常识填。
输出: {"values": {"<字段名>": {"found": true|false, "value": "<值或空字符串>"}}}`
// 别名表来自适配器（fieldAliases），不是写死在提示词里
function extractSys() {
  const al = Object.entries(ADAPTER?.fieldAliases || {}).filter(([k]) => k !== 'note')
  return EXTRACT_SYS + (al.length
    ? '\n【本环境已知的字段别名】' + al.map(([k, v]) => `任务里的「${v}」在界面上写作「${k}」`).join('；') + '。'
    : '')
}
async function sameName(a, b) {
  const r = await call('deepseek-flash',
    `你是判断器，只输出 JSON。判断两个姓名是否同一人(繁简/空格/中英文/同音字算不同写法但可能同一人)。证据不足给低置信度。\n输出 {"same":true|false,"conf":0..1,"why":"..."}`,
    `姓名一: ${JSON.stringify(a)}\n姓名二: ${JSON.stringify(b)}`, 'flash')
  return { same: r.json.same, conf: r.json.conf, ms: r.ms }
}

/* ============================ 代码：算事实 / 判规则 ============================ */
const ROWCOUNT = `(()=>{
  const bad=/未查询到|没有找到|暂无数据|请先|no data|empty/i;
  const rows=[...document.querySelectorAll('table tbody tr,[role=row],ul>li')]
    .filter(e=>e.offsetParent!==null && e.innerText.trim() && !bad.test(e.innerText));
  return rows.length;
})()`
const pageText = `(()=>{
  const vis=e=>{const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;
    const r=e.getBoundingClientRect();return r.width>10&&r.height>10};
  const ds=[...document.querySelectorAll('[role=dialog]')].filter(vis);
  const p=ds[ds.length-1];
  return (p?p.innerText:document.body.innerText).replace(/\\s+/g,' ').slice(0,1500);
})()`
void pageText   // 通用兜底文本；配了适配器时用 TEXTE（适配器的 textScope）

function evalOp(op, got, want) {
  switch (normOp(op)) {
    case '>': return Number(got) > Number(want)
    case '<': return Number(got) < Number(want)
    case '>=': return Number(got) >= Number(want)
    case '<=': return Number(got) <= Number(want)
    case '==': return String(got ?? '').toLowerCase().trim() === String(want ?? '').toLowerCase().trim()
    case '!=': return String(got ?? '').toLowerCase().trim() !== String(want ?? '').toLowerCase().trim()
    case 'isEmpty': return got === null || got === undefined || String(got).trim() === ''
    case '!isEmpty': return !(got === null || got === undefined || String(got).trim() === '')
    case 'isToday': return isToday(got)
    case '!isToday': return !isToday(got)
    case 'contains': return String(got ?? '').includes(String(want))
    default: return false
  }
}

/* 比较符归一 + 校验 ------------------------------------------------------------
 * 规划器天然会写 >= / ≤ / = 这些它自己词表里没有的符号。
 * 以前 evalOp 对不认识的操作符【静默返回 false】—— 规则永不命中，看起来像"没结果"，
 * 实际是写错了。这是最坏的一类失败：无声。现在统一归一，剩下的生面孔直接报出来。
 */
const KNOWN_OPS = new Set(['>', '<', '>=', '<=', '==', '!=', 'isEmpty', '!isEmpty', 'isToday', 'contains'])
const OP_ALIAS = { '≥': '>=', '≤': '<=', '=': '==', '===': '==', '!==': '!=', 'notEmpty': '!isEmpty', 'not_empty': '!isEmpty', 'is not empty': '!isEmpty' }
function normOp(op) { const s = String(op ?? '').trim(); return OP_ALIAS[s] || s }

const KNOWN_DO = new Set(['goto', 'fill', 'click', 'select', 'wait'])

/**
 * 计划体检：把所有会让规则【恒为假 / 永不命中】的结构性缺陷提前挑出来。
 * 这些缺陷以前全是无声的 —— 跑完只看到"无法判定"，看不出是哪儿写错了。
 *   ① 操作符不在词表         → 规则恒假
 *   ② 动作 do 不在词表       → 引擎当成找元素，白跑一步
 *   ③ snapshot 引用了不存在的事实
 *   ④ 规则依赖的事实没有任何动作去 snapshot → 事实永不就绪 → 规则永不命中
 */
function checkPlan(plan) {
  const bad = []
  for (const r of plan.rules || []) {
    if (!r.when) { bad.push(`${r.id}: 缺 when`); continue }
    const o = normOp(r.when.op)
    if (!KNOWN_OPS.has(o)) bad.push(`${r.id}: 操作符 ${JSON.stringify(r.when.op)} 不认识`)
    else r.when.op = o
  }
  const fids = new Set((plan.facts || []).map(f => f.id))
  for (const a of plan.actions || []) {
    if (!KNOWN_DO.has(a.do)) bad.push(`动作 ${JSON.stringify(a.do)} 不在词表里（只有 goto/fill/click/select/wait；采集事实是动作上的 snapshot 字段，不是一个动作）`)
    for (const s of a.snapshot || []) if (!fids.has(s)) bad.push(`动作上的 snapshot 引用了不存在的事实 ${s}`)
  }
  const snapped = new Set((plan.actions || []).flatMap(a => a.snapshot || []))
  for (const r of plan.rules || []) {
    if (!r.when?.fact) continue
    for (const id of ruleFacts(r, plan)) if (!snapped.has(id)) bad.push(`规则 ${r.id} 依赖事实 ${id}，但没有任何动作 snapshot 它 —— 这条规则永远不会命中`)
  }
  return bad
}
const checkOps = checkPlan   // 旧名保留
function isToday(s) {
  const m = String(s || '').match(/(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return false
  const d = new Date(), t = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${m[1]}-${m[2]}-${m[3]}` === t
}

/* ---- 页面就绪：适配器声明"什么元素出现才算能干活" ---- */
// document.readyState==='complete' 只说明文档加载完，不代表异步数据渲染完 ——
// 后者才是"能不能找到元素"的前提。少了这一等，第一次跑必然找不到元素。
async function waitReady(cdp) {
  const rd = ADAPTER?.ready?.selector
  if (!rd) return null
  const to = ADAPTER.ready.timeoutMs || 15000
  const t0 = Date.now()
  while (Date.now() - t0 < to) {
    if (await cdp.eval(`!!document.querySelector(${JSON.stringify(rd)})`).catch(() => false)) {
      console.log(`        就绪(${rd}) ✓ ${Date.now() - t0}ms`)
      return true
    }
    await sleep(300)
  }
  console.log(`        ⚠ 就绪判据 ${rd} 在 ${to}ms 内没出现（可能没登录，或页面改版）`)
  return false
}

/* ---- 网页防抖：适配器声明"计数稳定"策略时才等 ---- */
// 很多后台搜索框输入后有 1~3 秒防抖。固定 sleep 会读到中间态，必须轮询到稳定。
async function settle(cdp, act) {
  const w = ADAPTER?.wait
  if (!w || w.strategy !== 'pollCountStable' || !ADAPTER_COUNT) return
  const on = w.onActions || ['fill']
  if (!on.includes(act.do)) return
  const t0 = Date.now(), to = w.timeoutMs || 12000, iv = w.intervalMs || 500
  let prev, nulls = 0
  while (Date.now() - t0 < to) {
    await sleep(iv)
    const c = await cdp.eval(ADAPTER_COUNT).catch(() => null)
    if (c === null) { if (++nulls >= 2) return null } else nulls = 0
    if (c !== null && c === prev) { console.log(`        (计数稳定 = ${c}，等了 ${Date.now() - t0}ms)`); return c }
    prev = c
  }
  console.log(`        (计数未在 ${to}ms 内稳定，取最后值 ${prev})`)
  return prev ?? null
}

// 结论里的 {{fN}} / {{字段名}} 占位符 → 用已冻结的事实填上
function fillTpl(tpl, factsTable, planFacts) {
  return String(tpl || '').replace(/\{\{([^}]+)\}\}/g, (m, ref) => {
    const id = ref.trim()
    if (id in factsTable) return String(factsTable[id])
    const f = (planFacts || []).find(x => x.name === id || x.id === id)
    if (f && f.id in factsTable) return String(factsTable[f.id])
    return m
  })
}

// 结论校验：拿【已冻结的事实】复核结论是否自洽（修正规划器的规划错误）
async function verify(task, plan, facts, conclusion, ruleId, actLog) {
  const fv = Object.fromEntries(Object.entries(facts).map(([k, v]) => {
    const f = (plan.facts || []).find(x => x.id === k)
    return [k + (f ? '(' + f.kind + (f.name ? ':' + f.name : '') + ')' : ''), v]
  }))
  const r = await call('deepseek-v4-pro',
    `你是结论复核员，只输出 JSON。给你任务描述、已采集并冻结的事实、以及一个初步结论。
按事实和任务里的判定逻辑复核。只有在【事实与结论明确矛盾】时才改判；事实不足以判断时保持原结论(ok:true)，不要因为'无法确认'就推翻它。
输出 {"ok":true|false,"conclusion":"<最终结论，必要时修正>","why":"<一句话依据，引用具体事实>"}`,
    ['【任务描述】', task, '', '【已冻结的事实】', JSON.stringify(fv, null, 1), '',
     '【初步结论】', `(${ruleId}) ${conclusion}`].join('\n'), 'pro')
  const j = r.json
  if (j.ok === false || (j.conclusion && j.conclusion !== conclusion)) {
    console.log(`        ⚠ 复核推翻: ${conclusion}`)
    console.log(`        ✔ 修正为: ${j.conclusion}   —— ${j.why}`)
    return { conclusion: j.conclusion, rule: ruleId + '(复核修正)', plan, actLog, corrected: true }
  }
  console.log(`        ✔ 复核通过: ${j.why || ''}`)
  return { conclusion, rule: ruleId, plan, actLog }
}

/* ============================ 引擎主循环 ============================ */
async function execute(cdp, task) {
  const vars = {}   // {{变量}} 从任务描述里由 System 2 引用；这里放兜底
  let st = JSON.parse(await cdp.eval(PERCEIVE))
  console.log('■ 拆解任务 (deepseek-v4-pro)')
  // ---- 计划校验：① 操作符合法 ② 结局覆盖完整（各一次调用）----
  let plan = null, missing = [], badOps = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const notes = []
    if (missing.length) notes.push('上一次的计划漏掉了任务里这些可能结论，每一条都必须有 stop:true 的规则覆盖：\n' + missing.map(m => '  - ' + m).join('\n'))
    if (badOps.length) notes.push('上一次的计划有结构性错误，逐条改掉：\n' + badOps.map(m => '  - ' + m).join('\n'))
    plan = (await call('deepseek-v4-pro', S2_SYS, s2user(task, st, notes.join('\n\n') || null), 'pro')).json
    // 不认识的操作符会让规则【恒为假】——无声失败，必须先拦住
    badOps = checkOps(plan)
    if (badOps.length) { console.log(`  ⚠ 计划有结构性缺陷 → 重新拆解: ${badOps.join('; ')}`); missing = []; continue }
    const chk = await call('deepseek-flash',
      `你是计划审查员，只输出 JSON。任务描述里每一种可能的结局，都必须能在计划的 rules 里找到一条对应的 stop:true 规则（措辞可以不同，意思必须一致）。\n输出 {"missing":["<没被覆盖的结局描述>", ...]}  全都覆盖了就给 {"missing":[]}`,
      ['【任务描述】', task, '', '【计划的规则】', (plan.rules || []).map(r => `${r.id} stop=${!!r.stop} → ${r.conclusion}`).join('\n')].join('\n'), 'flash')
    missing = chk.json.missing || []
    if (!missing.length) { if (attempt) console.log(`  ✔ 第 ${attempt + 1} 次拆解通过校验`); break }
    console.log(`  ⚠ 漏掉 ${missing.length} 条结局 → 重新拆解: ${missing.map(m => m.slice(0, 24)).join(' / ')}`)
  }
  if (missing.length) console.log('  ⚠ 仍未覆盖全部结局，继续执行（走结论校验兜底）')
  if (badOps.length) console.log('  ⚠ 仍有结构性缺陷，相关规则会恒为假: ' + badOps.join('; '))
  console.log('  目标 : ' + plan.goal)
  console.log('  事实 : ' + (plan.facts || []).map(f => `${f.id}(${f.kind}${f.name ? ':' + f.name : ''})`).join('  '))
  console.log('  规则 :')
  for (const r of plan.rules || []) console.log(`     ${r.id}  if ${r.when.fact} ${r.when.op} ${JSON.stringify(r.when.value)}  →  ${r.conclusion}${r.stop ? '  [终止]' : ''}`)
  console.log('  动作 : ' + (plan.actions || []).length + ' 步')
  for (const a of plan.actions || []) console.log(`     ${a.do} ${a.target || a.url || ''} ${a.text !== undefined ? '= ' + a.text : ''} ${a.option ? '→ ' + a.option : ''} ${a.snapshot ? '[snapshot ' + a.snapshot.join(',') + ']' : ''} ${a.unless ? '[unless ' + a.unless.join(',') + ']' : ''}`)

  PLAN = plan; CDP_CONN = cdp
  facts = {}; ready = new Set()

  const firedRules = new Set()
  const tried = []
  const actLog = []

  for (let i = 0; i < (plan.actions || []).length; i++) {
    const act = plan.actions[i]
    if (act.unless && act.unless.some(id => firedRules.has(id))) { console.log(`\n[动作 ${i + 1}] ${act.do} ${act.target || act.url} —— 跳过(已命中 ${act.unless.filter(x=>firedRules.has(x)).join(',')})`); continue }
    console.log(`\n[动作 ${i + 1}] ${act.do}  ${act.target || act.url || ''}${act.text !== undefined ? '  = ' + act.text : ''}${act.option ? '  → ' + act.option : ''}`)

    // ---- goto ----
    if (act.do === 'goto') {
      let url = act.url
      if (process.env.OPS_MOCK) {   // 演示用：把内网地址换成等价的本地 mock 页（映射在 mocks.json）
        const mu = resolveMock(url)
        if (mu) { url = mu; console.log('        (mock) ' + url.split('/').pop()) }
      }
      await cdp.send('Page.navigate', { url })
      for (let k = 0; k < 40; k++) { await sleep(100); if (await cdp.eval('document.readyState') === 'complete') break }
      await sleep(300); await waitReady(cdp); st = JSON.parse(await cdp.eval(PERCEIVE))
      console.log('        已打开 ' + st.title)
      continue
    }
    if (act.do === 'wait') { await sleep(act.ms || 500); st = JSON.parse(await cdp.eval(PERCEIVE)); continue }

    // ---- 让 System 1 找元素（界面变了也不用改代码）----
    const f = await findElement(act.target, st, tried, act)
    const chosen = st.candidates.find(c => c.id === f.id)
    if (!chosen) { console.log(`        ✗ 没找到目标元素(模型给 ${f.id})`); tried.push(act.target); continue }
    // 二次把关：即使候选已按类型过滤过，也要防模型给一个类型不符的编号
    if (FIT[act.do] && !FIT[act.do](chosen)) {
      console.log(`        ✗ 元素类型不符: 「${act.do}」不能作用在 ${chosen.kind} "${chosen.name || chosen.text}" 上（模型选了 ${f.id}）`)
      tried.push(act.target); actLog.push({ act: act.target, result: '类型不符', element: chosen.kind }); continue
    }

    // ---- 危险拦截（代码：模型会被"点删除"这种指令说服，所以必须在代码层拦）----
    const label = (chosen.name || '') + ' ' + (chosen.text || '')
    if (GUARD_BLOCK.some(w => label.includes(w))) {
      console.log(`        🛡 危险拦截: ${label.trim()}`); actLog.push({ act: act.target, result: '危险拦截' }); continue
    }

    // ---- 执行（代码）—— 站点专有部分由适配器提供，引擎不含选择器 ----
    const snap = st.snap, id = chosen.id
    const expr = executeExpr(ADAPTER, act, id)

    const before = await cdp.eval(`JSON.stringify([document.body.innerText.length, document.querySelectorAll('[role=dialog]').length])`)
    const r = await cdp.eval(expr)
    console.log(`        选中 ${id} ${chosen.kind} "${chosen.name || chosen.text}" (${f.why}) → ${r}`)
    if (r !== 'OK') { tried.push(act.target); continue }
    const wsp = waitSpec(ADAPTER, act)
    await sleep(wsp.ms ?? 260)
    await settle(cdp, act)
    st = JSON.parse(await cdp.eval(PERCEIVE))
    const after = await cdp.eval(`JSON.stringify([document.body.innerText.length, document.querySelectorAll('[role=dialog]').length])`)
    console.log(`        界面变化: ${before !== after ? '是' : '否'}`)
    actLog.push({ act: `${act.do} ${act.target}`, element: `${id} ${chosen.name || chosen.text}`, changed: before !== after, conf: f.conf })

    // ---- 采集本动作指定的快照事实（每个事实只采一次，之后冻结）----
    if (act.snapshot && act.snapshot.length) {
      await snapshotFacts(act.snapshot)
      const fv = Object.fromEntries(act.snapshot.map(id => [id, facts[id]]))
      console.log('        快照: ' + JSON.stringify(fv) + '  已就绪: [' + [...ready].join(',') + ']')
    }

    // ---- 判规则：引用的事实【全部已冻结】才允许判（代码）----
    for (const rl of plan.rules || []) {
      if (firedRules.has(rl.id)) continue
      const need = ruleFacts(rl, plan)
      if (!need.every(id => ready.has(id))) continue
      const got = facts[rl.when.fact]
      if (evalOp(rl.when.op, got, rl.when.value)) {
        firedRules.add(rl.id)
        console.log(`        ✅ 命中规则 ${rl.id}: ${rl.conclusion}`)
        if (rl.stop) return { conclusion: fillTpl(rl.conclusion, facts, plan.facts), rule: rl.id, plan, actLog }
      }
    }
  }
  // ---- 闭环: 没有终结规则命中 → 让 System 2 只【补规则】，判定仍由代码用已冻结的事实做 ----
  console.log('\n■ 无终结规则命中 —— 反思: 只补规则, 判定仍由代码对已冻结事实做')
  const fv = Object.fromEntries(Object.entries(facts).map(([k, v]) => {
    const f = (plan.facts || []).find(x => x.id === k)
    return [k + (f ? '(' + f.kind + (f.name ? ':' + f.name : '') + ')' : ''), v]
  }))
  const fix = await call('deepseek-v4-pro',
    `你是规则修复器，只输出 JSON。给你任务描述和【已冻结的事实】——事实是唯一事实来源，不可质疑、不可改写。
任务里每一种可能的结局都必须有一条 stop:true 的规则，请补全/修正规则表，使当前这组事实能唯一命中一条。
when.fact 只能引用已存在的事实编号。op 只能用 > < == != isEmpty isToday contains。
输出 {"rules":[{"id":"x1","when":{"fact":"f1","op":">","value":0},"conclusion":"<完整中文结论>","stop":true}, ...]}`,
    ['【任务描述】', task, '', '【已冻结的事实】', JSON.stringify(fv, null, 1), '',
     '【原始规则表】', (plan.rules || []).map(r => `${r.id} if ${r.when.fact} ${r.when.op} ${JSON.stringify(r.when.value)} → ${r.conclusion}`).join('\n')].join('\n'),
    'pro')
  const fixed = fix.json.rules || []
  console.log('  修复后规则:')
  for (const r of fixed) console.log(`     ${r.id} if ${r.when.fact} ${r.when.op} ${JSON.stringify(r.when.value)} → ${r.conclusion}${r.stop ? ' [终止]' : ''}`)
  for (const rl of fixed) {
    if (!rl.stop || rl.when.fact === undefined || !(rl.when.fact in facts)) continue
    if (evalOp(rl.when.op, facts[rl.when.fact], rl.when.value)) {
      console.log(`  ✔ 修复后命中 ${rl.id}: ${rl.conclusion}`)
      return { conclusion: fillTpl(rl.conclusion, facts, plan.facts), rule: rl.id + '(规则修复)', plan, actLog }
    }
  }
  console.log('  ✗ 修复后仍无规则命中 —— 返回"无法判定"，不编结论')
  return { conclusion: '⚠ 无法判定（规则均未命中）—— 已采集事实: ' + JSON.stringify(fv), rule: '未命中', plan, actLog }
}


export { execute, CDP, getJSON, sleep, meter, PORT, CHROME, HERE }

/* ---- 窗口控制（浏览器级 CDP）：可被 engine / 外部脚本共用 ---- */
async function setWindowState(state) {
  const ver = await getJSON('/json/version')
  const list = await getJSON('/json/list')
  const page = list.find(t => t.type === 'page')
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(ver.webSocketDebuggerUrl)
    const pend = new Map(); let seq = 0
    ws.onerror = () => reject(new Error('连不上浏览器调试端口'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pend.get(m.id); if (!p) return
        pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      const send = (method, params = {}) => new Promise((R, J) => {
        const id = ++seq; pend.set(id, { resolve: R, reject: J })
        ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + method)) }, 8000)
      })
      ;(async () => {
        try {
          const { windowId } = await send('Browser.getWindowForTarget', { targetId: page?.id })
          if (state === 'normal') { await send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {}); await sleep(120) }
          await send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } })
          const b = await send('Browser.getWindowBounds', { windowId })
          ws.close(); resolve(b.bounds)
        } catch (e) { try { ws.close() } catch {}; reject(e) }
      })()
    }
  })
}

/* ==================================================================================
 * 快决策闭环（loop 模式）
 *
 * 和 plan 模式共用同一套：CDP / 感知 / 适配器 / 执行 / 历史。
 * 唯一的区别是【动作从哪来】：
 *   plan 模式：System 2 先把动作序列一次规划出来，再照着走
 *   loop 模式：没有预设序列，每一步现看现决定 —— 这才是能泛化到游戏/驾驶的那种形态
 *
 * 每一步：感知 → 快决策在可选项里选一个 → 代码执行 → 结果进历史 → 再感知
 * ================================================================================== */
const LOOP_SYS = `你是执行者，在按任务描述一步步操作一个环境。只输出 JSON。

每一步你只能从【可选项】里挑一个。

输出:
{"choice":"<可选项的 id>","conf":0.0~1.0,"why":"<6个字以内>"}

要求:
- choice 必须是【可选项】里列出的 id 之一，不要发明也不要拼写。
- 标了 [禁用] 的绝对不要选。
- 有明确目标就朝目标走，但要保证自己先活下来（撞墙、撞自己等于直接失败）。
- 只看得到【当前状态】和列出的最近步骤，不要臆造看不到的东西。
- 不确定就给低 conf，不要假装确定。`

// 统一表示：不管 dom 型还是 custom 型，引擎只认 { stateText, options }
function unifyState(st) {
  if (typeof st.state === 'string' && Array.isArray(st.options)) {
    return { stateText: st.state, options: st.options }               // custom：适配器直接给了
  }
  return {                                                             // dom：通用感知合成
    stateText: st2text(st),
    options: (st.candidates || []).map(c => ({
      id: c.id, label: `${c.kind} "${c.name || c.text}"`.trim(), enabled: c.enabled, _dom: true,
    })),
  }
}

// 历史压缩：只带最近 N 步，更早的压成一行统计。这是四个可修面之一，所以做成可配。
function loopUser(task, stateText, opts, hist) {
  const keep = Number(ADAPTER?.history?.recent || process.env.HIST_KEEP || 12)
  const optTxt = opts.map(o => `[${o.id}] ${o.label}${o.enabled === false ? '  [禁用]' : ''}`).join('\n')
  const L = ['【任务描述】', task, '', '【当前状态】', stateText, '', '【可选项】', optTxt]
  if (hist.length) {
    const early = hist.length - keep
    L.push('', `【已走 ${hist.length} 步】`)
    if (early > 0) L.push(`  （更早的 ${early} 步已压缩）累计移动到食物 ${hist.filter(h => h.ate).length} 次，被拒 ${hist.filter(h => h.bad).length} 次`)
    L.push(hist.slice(-keep).map(h => `  ${h.step}. 选 ${h.id}${h.label ? '(' + h.label + ')' : ''} → ${h.note}`).join('\n'))
  }
  return L.join('\n')
}

async function executeLoop(cdp, task) {
  const maxSteps = Number(ADAPTER?.maxSteps || process.env.MAX_STEPS || 200)
  const target = ADAPTER?.success?.target
  const kind = ADAPTER?.success?.kind || 'score'
  const hist = []
  // 环境在哪由适配器说了算（网页后台是任务描述里的 URL；游戏/模拟器是本地页）
  // startUrl 支持【相对路径】（相对 general/），这样换设备/换目录都不用改适配器
  const raw = process.env.START_URL || ADAPTER?.startUrl
  const startUrl = !raw ? null
    : (/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : 'file://' + (isAbsolute(raw) ? raw : join(HERE, raw)))
  if (startUrl) {
    console.log('  打开环境: ' + startUrl)
    await cdp.send('Page.navigate', { url: startUrl })
    for (let k = 0; k < 80; k++) { await sleep(150); if (await cdp.eval('document.readyState') === 'complete') break }
    await sleep(250); await waitReady(cdp)
  }
  let st = JSON.parse(await cdp.eval(PERCEIVE))
  if (st.seed !== undefined) console.log(`  随机种子: ${st.seed}   （START_URL 末尾加 ?seed=${st.seed} 可复现同一局）`)

  console.log('■ 快决策闭环（loop 模式）—— 每步现决定，不做整体规划')
  console.log(`  上限 ${maxSteps} 步` + (target !== undefined ? `   目标 ${kind} >= ${target}` : ''))

  for (let step = 1; step <= maxSteps; step++) {
    const { stateText, options } = unifyState(st)

    if (st.over) {
      const got = st[kind] ?? 0
      const ok = target === undefined ? null : got >= target
      console.log(`\n■ 环境报告结束：${st.reason || 'over'}`)
      return {
        conclusion: `游戏结束：${st.reason || '结束'}｜${kind} ${got}｜走了 ${hist.length} 步` +
          (ok === null ? '' : ok ? '｜✓ 达成目标' : `｜✗ 未达成目标（目标 ${target}）`),
        rule: ok === null ? '结束' : (ok ? '达成' : '未达成'),
        plan: { mode: 'loop', adapter: ADAPTER?.id, target, kind },
        actLog: hist,
      }
    }

    const d = await decideLoop(task, stateText, options, hist)
    const opt = options.find(o => String(o.id) === String(d.id))
    let note
    if (!opt) { note = `✗ 模型给了不存在的选项 ${JSON.stringify(d.id)}` }
    else if (opt.enabled === false) { note = '✗ 选了禁用项，跳过' }
    else {
      const act = opt.act || { do: 'click', target: opt.label }
      if (FIT[act.do] && opt._dom) {
        const c = (st.candidates || []).find(x => x.id === opt.id)
        if (c && !FIT[act.do](c)) { hist.push({ step, id: d.id, label: opt.label, note: `✗ 元素类型不符（${act.do} 不能作用在 ${c.kind}）`, bad: true, conf: d.conf }); console.log(`[${String(step).padStart(3)}] ${d.id} ${opt.label} → 类型不符`); continue }
      }
      const r = await cdp.eval(executeExpr(ADAPTER, act, opt.id))
      const wsp = waitSpec(ADAPTER, act)
      if (wsp.ms) await sleep(wsp.ms)
      const prevScore = st[kind]
      st = JSON.parse(await cdp.eval(PERCEIVE))
      const mv = st.last
      note = r !== 'OK' ? `✗ 执行失败 ${r}`
        : mv && mv.ok === false ? `✗ 被拒：${mv.reason || ''}`
        : mv && mv.over ? `✗ 本局结束：${mv.reason || st.reason || ''}`
        : mv && mv.ate ? `✓ 吃到 ${kind} +1`
        : (st[kind] !== prevScore ? `✓ ${kind} ${prevScore}→${st[kind]}` : '移动成功')
      hist.push({ step, id: d.id, label: opt.label, note, bad: /^✗/.test(note), conf: d.conf, ate: !!(mv && mv.ate) })
      console.log(`[${String(step).padStart(3)}] ${d.id} ${String(opt.label).padEnd(16)} conf=${d.conf ?? '-'}  ${note}${d.why ? '   (' + d.why + ')' : ''}`)
      continue
    }
    hist.push({ step, id: d?.id, label: opt?.label, note, bad: true, conf: d?.conf })
    console.log(`[${String(step).padStart(3)}] ${d?.id} ${note}`)
  }

  const { stateText } = unifyState(st)
  console.log('\n' + stateText.split('\n').slice(0, 3).join('\n'))
  return {
    conclusion: `⚠ 达到步数上限 ${maxSteps} 步仍未结束（${kind} ${st[kind] ?? 0}）`,
    rule: '超步数', plan: { mode: 'loop', adapter: ADAPTER?.id }, actLog: hist,
  }
}

async function decideLoop(task, stateText, options, hist) {
  const r = await call('deepseek-flash', LOOP_SYS, loopUser(task, stateText, options, hist), 'flash')
  const a = r.json || {}
  return { id: a.choice, conf: a.conf, why: a.why, ms: r.ms }
}

/* ============================ 直接运行时 ============================ */
if (process.argv[1] && process.argv[1].endsWith('engine.mjs') && process.env.TASK_FILE) {
  const task = readFileSync(process.env.TASK_FILE, 'utf8')
  // ATTACH=1 → 挂到【已经在跑】的浏览器上（登录态、标签页都保留），不自己起也不关它
  const ATTACH = /^(1|true|yes)$/i.test(process.env.ATTACH || '')
  let chrome = null
  if (!ATTACH) {
    // 【端口闸】端口上已经有人 = 上次残留的 Chrome。
    // 绝不能"连上就干"——那会静默操作一个陈旧页面，且结果看起来完全正常。
    const stale = await getJSON('/json/version').then(v => v.Browser).catch(() => null)
    if (stale) throw new Error(
      `端口 ${PORT} 已被占用（${stale}）—— 极可能是上次运行残留的 Chrome。\n` +
      `  清掉:  pkill -f 'chrome.*--remote-debugging-port=${PORT}'      （注意用 [c]hrome 写法避免杀掉自己）\n` +
      `  或明确挂上去:  ATTACH=1 CDP_PORT=${PORT} ...`)

    const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-port=' + PORT,
      '--user-data-dir=' + join(HERE, HEADED ? '.chrome-headed' : '.chrome'),
      '--no-first-run', '--no-default-browser-check']
    if (!HEADED) args.unshift('--headless')
    else args.push('--window-size=1280,880', '--window-position=60,40')
    chrome = spawn(CHROME, [...args, 'about:blank'],
      { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })
    // 被外部杀掉时也要收尸，否则残留 Chrome 会占着端口毒害下一次运行
    const bury = () => { try { chrome.kill('SIGKILL') } catch {} }
    process.on('exit', bury)
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { bury(); process.exit(128) })
  } else {
    // 【自愈】ATTACH 模式下常驻浏览器可能已经挂了（实测偶发）。
    // 直接失败会让人以为"脚本坏了"；这里自动拉起来 —— 登录态在 profile 里，不用重新登录。
    const alive = await getJSON('/json/version').then(() => true).catch(() => false)
    if (!alive) {
      console.log(`常驻浏览器不在（127.0.0.1:${PORT}）—— 自动拉起（登录态存在 profile 里，不用重新登录）`)
      spawnSync(process.execPath, [join(HERE, 'browser.mjs'), 'start'], { stdio: 'ignore' })
      await sleep(1500)
    }
  }
  let cdp
  try {
    let page = null
    for (let i = 0; i < 40 && !page; i++) { await sleep(300); try { page = (await getJSON('/json/list')).find(t => t.type === 'page') } catch {} }
    if (!page) throw new Error('Chrome 未就绪' + (ATTACH ? `（127.0.0.1:${PORT} 上没有窗口 —— 先 node browser.mjs status）` : ''))
    cdp = await CDP.connect(page.webSocketDebuggerUrl)
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
    if (ATTACH) console.log(`浏览器: 挂到 127.0.0.1:${PORT} 已有的窗口（当前 ${page.url.slice(0, 70)}）`)
    else if (HEADED) {
      console.log('浏览器: 有头模式（窗口已打开，可随时最小化/还原）')
      if (process.env.START_MIN) { await setWindowState('minimized'); console.log('  已按 START_MIN 最小化') }
    }
    console.log('═'.repeat(96))
    console.log('适配器: ' + describeAdapter(ADAPTER) + (ADAPTER ? '' : '    可用: ' + listAdapters().join(', ')))
    console.log('任务描述:')
    console.log(task.trim().split('\n').map(l => '  ' + l).join('\n'))
    console.log('═'.repeat(96))
    // 模式：plan（默认，先规划再执行）| loop（每步现决定，游戏/连续环境用）
    const USE_LOOP = /^(loop|闭环)$/i.test(process.env.MODE || '') || (!process.env.MODE && ADAPTER?.kind === 'custom')
    console.log('模式: ' + (USE_LOOP ? 'loop 快决策闭环（每步现决定）' : 'plan 先规划再执行'))
    const r = USE_LOOP ? await executeLoop(cdp, task) : await execute(cdp, task)
    console.log('\n' + '═'.repeat(96))
    console.log(r.conclusion ? '▶ 结论: ' + r.conclusion : '▶ 未得出结论（规则都没命中）')
    console.log(`▶ 模型 ${meter.calls} 次  $${meter.cost.toFixed(6)}  模型耗时 ${(meter.ms / 1000).toFixed(2)}s`)
    console.log('═'.repeat(96))
  } finally { try { cdp?.ws.close() } catch {}; chrome?.kill('SIGKILL') }
}
