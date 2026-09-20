#!/usr/bin/env node
/**
 * SiteA 真实页面 · 第一步「搜工号 / 搜邮箱」
 *
 * 站点适配器（这些是 SiteA 专有的，通用层不该知道）:
 *   搜索框   input[placeholder*="查找成员"]          输入即搜，不需要按钮/回车
 *   结果计数 .memberList-account  文本 "用户名 (N)"  ← 唯一可靠判据
 *   数据行   .ui-table-body .ui-table-row           div，不是 tr
 *   列序     1=用户名 2=邮箱 3=部门 … 8=工号 10=状态
 *   等待     约 3-4 秒防抖；行数上限 22 所以【不能用行数当判据】
 *
 * 用法: node site_sitea.mjs <工号> [邮箱]
 *       node site_sitea.mjs 10000001 zhangsan@internal.example
 */
import http from 'node:http'
const PORT = Number(process.env.CDP_PORT || 9240)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJSON = p => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2500 }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  }); q.on('error', rej); q.on('timeout', () => q.destroy(new Error('t')))
})
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pend = new Map(); let s = 0
    ws.onerror = () => reject(new Error('ws'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pend.get(m.id); if (!p) return
        pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      resolve({ send: (me, pa = {}) => new Promise((R, J) => {
        const id = ++s; pend.set(id, { resolve: R, reject: J })
        ws.send(JSON.stringify({ id, method: me, params: pa }))
        setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + me)) }, 20000)
      }), close: () => ws.close() })
    }
  })
}
const ver = await getJSON('/json/version'), list = await getJSON('/json/list')
const page = list.find(t => t.type === 'page')
const pc = await connect(page.webSocketDebuggerUrl); await pc.send('Runtime.enable')
const ev = e => pc.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
})

/* ---------------- 站点适配器（唯一的站点专有部分） ---------------- */
const SiteA = {
  search: `[...document.querySelectorAll('input')].find(i=>/查找成员/.test(i.placeholder||''))`,
  count: `(()=>{const a=document.querySelector('.memberList-account');
           const m=(a?.innerText||'').match(/\\((\\d+)\\)/); return m?+m[1]:null})()`,
  rows: `[...document.querySelectorAll('.ui-table-body .ui-table-row')]`,
  COL: { name: 1, email: 2, empId: 8, status: 10 },
}
const type = v => ev(`(()=>{const el=${SiteA.search}; if(!el) return 'NOEL';
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value})()`)

// 等计数稳定：连续两次读到同一个非 null 值
async function waitCount(maxMs = 12000) {
  const t0 = Date.now(); let prev = undefined
  while (Date.now() - t0 < maxMs) {
    await sleep(500)
    const c = await ev(SiteA.count)
    if (c !== null && c === prev) return { count: c, ms: Date.now() - t0 }
    prev = c
  }
  return { count: prev ?? null, ms: Date.now() - t0, timeout: true }
}
const firstRow = () => ev(`(()=>{const rs=${SiteA.rows}; const r=rs[0]; if(!r) return null;
  const c=[...r.children].map(x=>(x.innerText||'').replace(/\\s+/g,' ').trim());
  return JSON.stringify({name:c[${SiteA.COL.name}],email:c[${SiteA.COL.email}],empId:c[${SiteA.COL.empId}],status:c[${SiteA.COL.status}]})})()`)

async function searchAndCount(v, tag) {
  await type(v)
  const r = await waitCount()
  console.log(`  [${tag}] 搜 ${JSON.stringify(v).padEnd(26)} → 计数 ${r.count}  (${r.ms}ms${r.timeout ? ' ⚠超时' : ''})`)
  return r.count
}

/* ---------------- 跑第一步 ---------------- */
const EMPID = process.argv[2]
const EMAIL = process.argv[3]
if (!EMPID) { console.error('用法: node site_sitea.mjs <工号> [邮箱]'); process.exit(1) }

console.log('═'.repeat(72))
console.log('SiteA 第一步：搜工号 → 搜邮箱')
console.log('  当前页: ' + page.url.slice(0, 90))
console.log('═'.repeat(72))

// 先清空
await type(''); await sleep(1500)

const c1 = await searchAndCount(EMPID, '工号')
if (c1 > 0) {
  const row = await firstRow()
  console.log('\n▶ 结论: 工号在 SiteA 中存在 → 【用户自身问题】（不是同步问题）')
  console.log('  命中行: ' + (row || '(读不到)'))
} else if (EMAIL) {
  const c2 = await searchAndCount(EMAIL, '邮箱')
  if (c2 === 0) {
    console.log('\n▶ 结论: 工号和邮箱在 SiteA 中都搜不到 → 【进入第二步 SiteB】')
  } else {
    const row = JSON.parse(await firstRow() || 'null')
    console.log('\n  命中行: ' + JSON.stringify(row))
    console.log('\n▶ 结论: 邮箱在 SiteA 中存在 → 需要看详情面板的「工号」字段是否为空')
    console.log('  （下一步：点进这一行的详情）')
  }
} else {
  console.log('\n▶ 工号搜不到。未提供邮箱，无法继续。')
}

await type(''); await sleep(1200)
console.log('\n已清空搜索框')
pc.close()
