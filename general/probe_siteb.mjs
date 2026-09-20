#!/usr/bin/env node
/**
 * SiteB org_user_management 侦察：
 *  1) 搜索类型下拉有哪些选项
 *  2) 切成「用户名」+ 输入工号 + 查询 → 结果行长什么样
 *  3) 怎么进详情、详情里有没有「邮箱」「信息更新时间」
 */
import http from 'node:http'
const PORT = Number(process.env.CDP_PORT || 9240)
const EMPID = process.argv[2] || '8353988'
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

const trace = []
const step = (who, what) => { trace.push(`[${who}] ${what}`); console.log(`[${who}] ${what}`) }

/* ---- 1) 搜索类型下拉 ---- */
console.log('═'.repeat(76))
console.log('① 搜索类型下拉')
const selInfo = await ev(`(()=>{
  const ins=[...document.querySelectorAll('input')];
  const kw=ins.find(i=>/^请输入$/.test(i.placeholder||''));
  if(!kw) return JSON.stringify({err:'找不到搜索输入框'});
  let p=kw, out=[];
  for(let k=0;k<5&&p;k++){ p=p.parentElement; if(!p) break;
    out.push({lvl:k, tag:p.tagName, cls:(p.className||'').slice(0,70), txt:(p.innerText||'').replace(/\\s+/g,' ').slice(0,90)});
  }
  return JSON.stringify(out,null,1);
})()`)
console.log(selInfo)

/* ---- 2) 找到那个下拉触发器并点开 ---- */
console.log('\n' + '═'.repeat(76))
console.log('② 点开下拉，列选项')
const opened = await ev(`(()=>{
  const kw=[...document.querySelectorAll('input')].find(i=>/^请输入$/.test(i.placeholder||''));
  if(!kw) return 'NO_KW';
  // 搜索框前面那个显示"姓名"的可点元素
  let box=kw.parentElement;
  for(let k=0;k<4&&box;k++){
    const cand=[...box.querySelectorAll('*')].filter(e=>e.children.length===0 && /^(姓名|用户名|工号|邮箱|手机号)$/.test((e.innerText||'').trim()));
    if(cand.length){ cand[0].click(); return 'CLICKED:'+cand[0].innerText.trim(); }
    box=box.parentElement;
  }
  return 'NOT_FOUND';
})()`)
console.log('  → ' + opened)
await sleep(1200)
const opts = await ev(`(()=>{
  const vis=e=>{const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;const r=e.getBoundingClientRect();return r.width>4&&r.height>4};
  const items=[...document.querySelectorAll('li,[role=option],[class*=option],[class*=dropdown-item],[class*=select-item]')]
    .filter(vis).map(e=>(e.innerText||'').trim()).filter(t=>t&&t.length<12);
  return JSON.stringify([...new Set(items)].slice(0,20));
})()`)
console.log('  选项: ' + opts)

/* ---- 3) 选「用户名」 ---- */
console.log('\n' + '═'.repeat(76))
console.log('③ 选中「用户名」')
const picked = await ev(`(()=>{
  const vis=e=>{const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;const r=e.getBoundingClientRect();return r.width>4&&r.height>4};
  const el=[...document.querySelectorAll('li,[role=option],[class*=option],[class*=dropdown-item],[class*=select-item]')]
    .filter(vis).find(e=>(e.innerText||'').trim()==='用户名');
  if(!el) return 'NOT_FOUND';
  el.click(); return 'OK';
})()`)
console.log('  → ' + picked)
await sleep(900)
console.log('  当前搜索类型: ' + await ev(`(()=>{const kw=[...document.querySelectorAll('input')].find(i=>/^请输入$/.test(i.placeholder||''));
  let p=kw; for(let k=0;k<4&&p;k++){const t=(p.innerText||'').trim(); if(t&&t.length<20) return t; p=p.parentElement;} return '?'})()`))

/* ---- 4) 输入工号 + 查询 ---- */
console.log('\n' + '═'.repeat(76))
console.log('④ 输入工号 ' + EMPID + ' 并查询')
await ev(`(()=>{const el=[...document.querySelectorAll('input')].find(i=>/^请输入$/.test(i.placeholder||''));
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  set.call(el, ${JSON.stringify(EMPID)}); el.dispatchEvent(new Event('input',{bubbles:true})); return 1})()`)
await sleep(500)
await ev(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/查\\s*询/.test(x.innerText)); if(b) b.click(); return 1})()`)
await sleep(3500)

const table = await ev(`(()=>{
  const rows=[...document.querySelectorAll('tr,[class*=table-row],[role=row]')]
    .filter(r=>r.offsetParent!==null && (r.innerText||'').trim());
  const empty=/暂无数据/.test(document.body.innerText);
  return JSON.stringify({empty, n:rows.length, rows:rows.slice(0,8).map(r=>(r.innerText||'').replace(/\\s+/g,' ').slice(0,150))},null,1);
})()`)
console.log('  表格: ' + table)

/* ---- 5) 进详情 ---- */
console.log('\n' + '═'.repeat(76))
console.log('⑤ 尝试进详情')
const detailHit = await ev(`(()=>{
  const vis=e=>{const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;const r=e.getBoundingClientRect();return r.width>4&&r.height>4};
  // 找"操作"列里的可点元素，或用户名单元格
  const cands=[...document.querySelectorAll('a,button,[class*=link],[class*=action]')].filter(vis)
    .filter(e=>/详情|查看|编辑|用户名/.test((e.innerText||'')+(e.getAttribute('title')||'')));
  if(cands.length){ const t=cands.map(e=>(e.innerText||e.getAttribute('title')||'').trim()).slice(0,8);
    cands[0].click(); return JSON.stringify({clicked:t[0], all:t}); }
  return 'NO_DETAIL_ENTRY';
})()`)
console.log('  → ' + detailHit)
await sleep(2500)

const after = await ev(`(()=>{
  const t=document.body.innerText.replace(/\\s+/g,' ');
  const hasEmail=/邮箱|电子邮件|E-?mail/i.test(t);
  const hasUpd=/更新时间|更新日期|最后更新|修改时间/i.test(t);
  const panel=[...document.querySelectorAll('[role=dialog],[class*=drawer],[class*=modal],[class*=panel]')]
    .filter(e=>e.offsetParent!==null).map(e=>(e.innerText||'').replace(/\\s+/g,' ').slice(0,400));
  return JSON.stringify({hasEmail, hasUpd, panels:panel.slice(0,2), tail:t.slice(-500)},null,1);
})()`)
console.log(after)
console.log('\n' + '─'.repeat(76))
console.log('轨迹: ' + trace.length + ' 步')
pc.close()
