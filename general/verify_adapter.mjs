#!/usr/bin/env node
/**
 * 第 1 步验证：适配器到底有没有被消费？
 *
 * 同一个页面、同一时刻，跑两遍对比：
 *   ① 通用启发式（不挂适配器）—— 引擎原来的行为
 *   ② 挂适配器 sitea.json         —— 引擎现在的行为
 *
 * 比三件事：候选元素 / 结果计数 / 等待策略。
 * 挂到常驻浏览器（默认 9240）上，不新开窗口，用完不关它。
 *
 *   node verify_adapter.mjs [工号]
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAdapter, describeAdapter, perceiveExpr, countExpr, textExpr, executeExpr, waitSpec } from './adapter.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.CDP_PORT || 9240)
const PERCEIVE_SRC = readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')
const URL_SiteA = 'https://sitea.internal.example/project/#/team/TEAMID/team_setting/department/all_member'
const EMPID = process.argv[2] || '10000001'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJSON = p => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2500 }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  }); q.on('error', rej); q.on('timeout', () => q.destroy(new Error('timeout')))
})
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pend = new Map(); let s = 0
    ws.onerror = () => reject(new Error('ws error'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pend.get(m.id); if (!p) return
        pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      resolve({
        send: (me, pa = {}) => new Promise((R, J) => {
          const id = ++s; pend.set(id, { resolve: R, reject: J })
          ws.send(JSON.stringify({ id, method: me, params: pa }))
          setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + me)) }, 25000)
        }), close: () => ws.close(),
      })
    }
  })
}

/* ---------------- 挂到常驻浏览器 ---------------- */
const list = await getJSON('/json/list')
const page = list.find(t => t.type === 'page')
if (!page) { console.error(`127.0.0.1:${PORT} 上没有窗口 —— 先 node browser.mjs status`); process.exit(1) }
const pc = await connect(page.webSocketDebuggerUrl)
await pc.send('Page.enable'); await pc.send('Runtime.enable')
const ev = e => pc.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
})

/* ---------------- 两个版本 ---------------- */
const A = loadAdapter('sitea')
const P_NO = perceiveExpr(null, PERCEIVE_SRC)      // 通用：删掉 __ADAPTER__
const P_YES = perceiveExpr(A, PERCEIVE_SRC)        // 挂适配器
const CNT = countExpr(A)                           // 适配器的计数规则
// 引擎里原来的通用计数（逐字抄自 engine.mjs 的 ROWCOUNT，用于对比）
const CNT_GENERIC = `(()=>{
  const bad=/未查询到|没有找到|暂无数据|请先|no data|empty/i;
  const rows=[...document.querySelectorAll('table tbody tr,[role=row],ul>li')]
    .filter(e=>e.offsetParent!==null && e.innerText.trim() && !bad.test(e.innerText));
  return rows.length;
})()`

console.log('═'.repeat(78))
console.log('第 1 步验证  适配器: ' + describeAdapter(A))
console.log('  路径: ' + A.__path)
console.log('═'.repeat(78))

/* ---------------- 打开页面 ---------------- */
console.log('\n① 打开 SiteA 全部成员页 …')
await pc.send('Page.navigate', { url: URL_SiteA })
for (let i = 0; i < 60; i++) { await sleep(250); if (await ev('document.readyState') === 'complete') break }
// 就绪判据也来自适配器：ready.selector
const ready = await (async () => {
  for (let i = 0; i < 40; i++) {
    if (await ev(`!!document.querySelector(${JSON.stringify(A.ready.selector)})`)) return true
    await sleep(250)
  }
  return false
})()
console.log(`   ready(${A.ready.selector}) = ${ready ? '✓ 出现' : '✗ 超时（可能没登录）'}`)

/* ---------------- 对比 1：候选元素 ---------------- */
console.log('\n② 候选元素对比')
const st0 = JSON.parse(await ev(P_NO))
const st1 = JSON.parse(await ev(P_YES))
console.log(`   通用启发式 : ${String(st0.candidates.length).padStart(4)} 个候选   count=${st0.count}   adapter=${st0.adapter}`)
console.log(`   挂适配器   : ${String(st1.candidates.length).padStart(4)} 个候选   count=${st1.count}   adapter=${st1.adapter}`)
const rows0 = st0.candidates.filter(c => c.kind === 'row').length
const rows1 = st1.candidates.filter(c => c.kind === 'row').length
console.log(`   认成数据行的 : 通用 ${rows0}   适配器 ${rows1}      ← 差在 perceive.rowSelector`)
console.log(`   适配器还额外给了 count=${st1.count}（直接进状态，模型不用自己数）`)
console.log(`   计数格原文: ${JSON.stringify(await ev(`(document.querySelector(${JSON.stringify(A.count.selector)})||{}).innerText`))}`)

/* ---------------- 对比 2：结果计数 ---------------- */
console.log('\n③ 结果计数对比（这条是这次改动最实在的地方）')
const g0 = await ev(CNT_GENERIC), a0 = await ev(CNT)

/* ---------------- 输入工号，再比一次 ---------------- */
console.log(`\n④ 在搜索框输入 ${EMPID}（执行也走适配器给的 executeExpr）`)
const box = st1.candidates.find(c => (c.name || '').includes('查找成员') || (c.name || '').includes('用户名、邮箱'))
if (!box) {
  console.log('   ✗ 候选里没找到搜索框。前 15 个候选:')
  st1.candidates.slice(0, 15).forEach(c => console.log(`      [${c.id}] ${c.kind} name="${c.name}" text="${c.text}"`))
} else {
  const r = await ev(executeExpr(A, { do: 'fill', text: EMPID }, box.id))
  console.log(`   选中 [${box.id}] ${box.kind} name="${box.name}"  → ${r}`)
  const wsp = waitSpec(A, { do: 'fill' })
  console.log(`   等待策略(来自适配器): ${wsp.strategy}  轮询 ${wsp.intervalMs}ms  上限 ${wsp.timeoutMs}ms`)

  // 按适配器声明的策略轮询：连续两次读到同一个非 null 值才算稳
  const t0 = Date.now(); let prev; const trace = []
  while (Date.now() - t0 < wsp.timeoutMs) {
    await sleep(wsp.intervalMs)
    const c = await ev(CNT)
    trace.push(c)
    if (c !== null && c === prev) break
    prev = c
  }
  console.log(`   轮询轨迹: ${trace.map(x => x === null ? '·' : x).join(' → ')}   (${Date.now() - t0}ms)`)
}

const g1 = await ev(CNT_GENERIC), a1 = await ev(CNT)
console.log('\n⑤ 结果')
console.log('   ┌────────────────┬──────────────┬──────────────┐')
console.log('   │                │ 通用启发式    │ 挂适配器      │')
console.log('   ├────────────────┼──────────────┼──────────────┤')
console.log(`   │ 搜索前         │ ${String(g0).padEnd(12)} │ ${String(a0).padEnd(12)} │`)
console.log(`   │ 搜 ${EMPID} │ ${String(g1).padEnd(12)} │ ${String(a1).padEnd(12)} │`)
console.log('   └────────────────┴──────────────┴──────────────┘')
console.log('\n   通用那条数的是 DOM 行数（封顶 22，代表不了命中数）；')
console.log('   适配器那条读的是页面自己报的「用户名 (N)」—— 这才是判据。')

/* ---------------- 收尾：清空搜索框 ---------------- */
if (box) { await ev(executeExpr(A, { do: 'fill', text: '' }, box.id)); await sleep(1500) }
console.log('\n已清空搜索框。浏览器保持打开。')
pc.close()
