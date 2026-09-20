#!/usr/bin/env node
/** 探测 SiteA 成员页的搜索行为：什么才能在 DOM 上可靠区分"有结果/无结果" */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
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
const ver = await getJSON('/json/version')
const list = await getJSON('/json/list')
const page = list.find(t => t.type === 'page')
const pc = await connect(page.webSocketDebuggerUrl)
await pc.send('Runtime.enable')
const ev = e => pc.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
})

// 定位搜索框：按 placeholder 找
const FIND_SEARCH = `(()=>{
  const ins=[...document.querySelectorAll('input')];
  const hit=ins.find(i=>/用户名.*邮箱.*工号|查找成员/.test(i.placeholder||''));
  return hit ? (hit.id || (hit.className||'') + '|' + hit.placeholder) : 'NOT_FOUND';
})()`
// 读列头计数：形如 "用户名 (9353)"
const READ_HEADER = `(()=>{
  const t=document.body.innerText;
  const m=t.match(/用户名\\s*\\((\\d+)\\)/);
  const rows=document.querySelectorAll('table tbody tr').length;
  const empty=/暂无数据|无数据|没有找到|No Data/i.test(t);
  const anyTable=document.querySelectorAll('table').length;
  return JSON.stringify({header:m?+m[1]:null, rows, empty, tables:anyTable});
})()`

async function typeAndSearch(v) {
  await ev(`(()=>{
    const ins=[...document.querySelectorAll('input')];
    const el=ins.find(i=>/用户名.*邮箱.*工号|查找成员/.test(i.placeholder||''));
    if(!el) return 'NO';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,bubbles:true}));
    el.dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',keyCode:13,bubbles:true}));
    return 'OK';
  })()`)
}

console.log('搜索框定位: ' + await ev(FIND_SEARCH))
console.log('\n实验开始（每步等 2.5 秒）\n' + '─'.repeat(70))
console.log('%-24s %s'.replace(/%-?(\d+)s/g, (m, n) => '').length ? '' : '')

const steps = [
  ['基线（未搜索）', null],
  ['搜一个绝不可能存在的串', 'zzqqxx9988'],
  ['清空再搜真实姓名「张三」', '张三'],
  ['搜一个邮箱前缀 zhangsan', 'zhangsan'],
  ['清空', ''],
]
for (const [tag, v] of steps) {
  if (v !== null) { await typeAndSearch(v); await sleep(2600) }
  const r = JSON.parse(await ev(READ_HEADER))
  console.log(`${tag.padEnd(26)} 列头计数=${String(r.header).padEnd(6)} tbody行数=${String(r.rows).padEnd(4)} 出现"无数据"文案=${r.empty}  表格数=${r.tables}`)
}

console.log('\n' + '─'.repeat(70))
console.log('表格结构（第 1 行各单元格）:')
console.log(await ev(`(()=>{
  const tr=document.querySelector('table tbody tr'); if(!tr) return '(无行)';
  return [...tr.querySelectorAll('td')].map((td,i)=>'td['+i+']="'+td.innerText.replace(/\\s+/g,' ').slice(0,28)+'"').join('  ');
})()`))
console.log('\nthead 各单元格:')
console.log(await ev(`(()=>{
  const t=document.querySelector('table'); if(!t) return '(无表)';
  return [...t.querySelectorAll('thead th,thead td')].map((th,i)=>'th['+i+']="'+th.innerText.replace(/\\s+/g,' ').slice(0,24)+'"').join('  ');
})()`))
console.log('\n后 35 个候选元素:')
const st = JSON.parse(await ev(readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')))
for (const c of st.candidates.slice(30))
  console.log(`  [${c.id.padEnd(4)}] ${(c.kind||'').padEnd(20)} ${(c.name||'').slice(0,22).padEnd(24)} ${(c.text||'').slice(0,26).padEnd(28)} ${c.zone==='panel'?'面板 ':''}${c.enabled?'':'禁用'}`)
pc.close()
