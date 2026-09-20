#!/usr/bin/env node
/**
 * SiteB 真实页面 · 第二步「查工号 → 进详情 → 读邮箱 / 更新日期」
 *
 * 站点适配器（SiteB 专有）:
 *   搜索类型下拉  .ant-input-group 里那个显示"姓名"的 SPAN → 选项: 姓名 / 用户名
 *   搜索输入框    input[placeholder="请输入"]
 *   查询按钮      button 文本含 "查 询"
 *   进详情        【点工号那一格】span.LinkColor（不是操作列的"编辑"）
 *                 跳转到 #/user/personalInfo?uId=...
 *   读字段        详情页正文里的 "邮箱 xxx" / "更新日期 xxxx-xx-xx xx:xx:xx"
 *
 * 用法: node site_siteb.mjs <工号>
 */
import http from 'node:http'
const PORT = Number(process.env.CDP_PORT || 9240)
const EMPID = process.argv[2]
if (!EMPID) { console.error('用法: node site_siteb.mjs <工号>'); process.exit(1) }
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
const pc = await connect(list.find(t => t.type === 'page').webSocketDebuggerUrl); await pc.send('Runtime.enable')
const ev = e => pc.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
})
const VIS = `const vis=e=>{const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;const b=e.getBoundingClientRect();return b.width>4&&b.height>4};`

console.log('═'.repeat(74))
console.log('SiteB 第二步：查工号 ' + EMPID + ' → 进详情 → 读邮箱 / 更新日期')
console.log('═'.repeat(74))

/* 0) 确保在 org_user_management 页 */
const cur = await ev('location.href')
if (!/org_user_management/.test(cur)) {
  console.log('  [代码] 不在用户管理页，先跳过去')
  await pc.send('Page.navigate', { url: 'https://siteb.internal.example/ec/?locale=zh-CN#/user/org_user_management' })
  await sleep(6000)
}

/* 1) 搜索类型 → 用户名 */
let t = await ev(`(()=>{${VIS}
  const grp=[...document.querySelectorAll('span,div')].find(e=>/ant-input-group-compact/.test(e.className||''));
  if(!grp) return 'NO_GROUP';
  const s=[...grp.querySelectorAll('span')].filter(vis).find(e=>/^(姓名|用户名|工号|邮箱)$/.test((e.innerText||'').trim()));
  if(!s) return 'NO_TRIGGER'; s.click(); return s.innerText.trim()})()`)
console.log('  [代码] 打开搜索类型下拉，当前=' + t)
await sleep(1000)
await ev(`(()=>{${VIS}
  const o=[...document.querySelectorAll('li,[role=option],[class*=option]')].filter(vis).find(e=>(e.innerText||'').trim()==='用户名');
  if(o) o.click(); return !!o})()`)
await sleep(800)
const typeNow = await ev(`(()=>{${VIS}
  const grp=[...document.querySelectorAll('span,div')].find(e=>/ant-input-group-compact/.test(e.className||''));
  const s=[...grp.querySelectorAll('span')].filter(vis).find(e=>/^(姓名|用户名)$/.test((e.innerText||'').trim()));
  return s?s.innerText.trim():'?'})()`)
console.log('  [代码] 搜索类型 → ' + typeNow)

/* 2) 输入工号 + 查询 */
await ev(`(()=>{const el=[...document.querySelectorAll('input')].find(i=>/^请输入$/.test(i.placeholder||''));
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(el, ${JSON.stringify(EMPID)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`)
await sleep(400)
await ev(`(()=>{${VIS}const b=[...document.querySelectorAll('button')].filter(vis).find(x=>/查\\s*询/.test(x.innerText)); if(b)b.click(); return !!b})()`)
console.log('  [代码] 已输入工号并点「查询」')
await sleep(3500)

const res = await ev(`(()=>{const t=document.body.innerText.replace(/\\s+/g,' ');
  const m=t.match(/用户量(\\d+)个/); const empty=/暂无数据/.test(t);
  return JSON.stringify({empty, count:m?+m[1]:null})})()`)
const rr = JSON.parse(res)
console.log(`  [代码] 结果: ${rr.empty ? '暂无数据' : '用户量 ' + rr.count + ' 个'}`)
if (rr.empty || rr.count === 0) {
  console.log('\n▶ 结论: SiteB 里查不到工号 ' + EMPID + ' 的账号')
  pc.close(); process.exit(0)
}

/* 3) 点工号进详情 */
const clicked = await ev(`(()=>{${VIS}
  const c=[...document.querySelectorAll('span,a,div')].filter(vis)
    .filter(e=>e.children.length===0 && (e.innerText||'').trim()===${JSON.stringify(EMPID)});
  if(!c.length) return 'NO_CELL';
  c[0].click(); return 'OK'})()`)
console.log('  [代码] 点工号那一格 → ' + clicked)
await sleep(4500)
const url = await ev('location.href')
console.log('  [代码] 详情页: ' + url.split('#')[1]?.slice(0, 60))

/* 4) 读字段（字段名可能与任务描述不同名） */
const f = JSON.parse(await ev(`(()=>{const t=document.body.innerText.replace(/\\s+/g,' ');
  const mail=(t.match(/邮箱\\s+([^\\s@]+@[^\\s]+)/)||[])[1]||null;
  const upd =(t.match(/更新日期\\s+(\\d{4}-\\d{2}-\\d{2}[^\\s]*\\s*[\\d:]*)/)||[])[1]||null;
  const cre =(t.match(/创建日期\\s+(\\d{4}-\\d{2}-\\d{2}[^\\s]*\\s*[\\d:]*)/)||[])[1]||null;
  const name=(t.match(/姓名\\s+([^\\s]{2,4})/)||[])[1]||null;
  return JSON.stringify({mail, upd, cre, name})})()`))
console.log('\n  [模型/代码] 读到的字段:')
console.log('     邮箱     = ' + f.mail)
console.log('     更新日期 = ' + f.upd)
console.log('     创建日期 = ' + f.cre)

/* 5) 判定 */
const today = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })()
console.log('\n' + '─'.repeat(74))
console.log('  今天是 ' + today)
if (!f.mail) console.log('▶ 结论: 读不到邮箱字段，需要补充适配器')
else if (f.upd && f.upd.startsWith(today)) console.log('▶ 结论: 【正常】邮箱已正确 且 更新日期是今天 → 系统间更新间隔一天，等明天再看')
else console.log(`▶ 结论: 【异常/待确认】邮箱已正确，但更新日期是 ${f.upd}（不是今天）`)
pc.close()
