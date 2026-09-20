#!/usr/bin/env node
/** 查清「用户名 (N)」这个计数到底挂在哪、什么时候能稳定读到 */
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
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
const ver = await getJSON('/json/version'); const list = await getJSON('/json/list')
const page = list.find(t => t.type === 'page')
const pc = await connect(page.webSocketDebuggerUrl); await pc.send('Runtime.enable')
const ev = e => pc.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }).then(r => {
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
})

const SET = v => `(()=>{
  const el=[...document.querySelectorAll('input')].find(i=>/查找成员/.test(i.placeholder||''));
  if(!el) return 'NO';
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  setter.call(el, ${JSON.stringify(v)});
  el.dispatchEvent(new Event('input',{bubbles:true}));
  return 'OK';
})()`

// 找到承载"用户名 (N)"的那个元素，把它和它的祖先文本都打出来
const FIND_COUNT_NODE = `(()=>{
  const out=[];
  const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let n; while(n=walk.nextNode()){
    const t=n.textContent||'';
    if(/用户名/.test(t)){ const p=n.parentElement;
      out.push({text:t.replace(/\\s+/g,' ').slice(0,40), tag:p.tagName, cls:(p.className||'').slice(0,50),
                parentText:(p.parentElement?.innerText||'').replace(/\\s+/g,' ').slice(0,70)});
    }
    if(out.length>6) break;
  }
  return JSON.stringify(out);
})()`

const READ = `(()=>{
  const t=document.body.innerText.replace(/\\s+/g,' ');
  const m=t.match(/用户名\\s*\\((\\d+)\\)/);
  return m ? +m[1] : null;
})()`

console.log('=== "用户名" 文本节点挂在哪 ===')
console.log(await ev(FIND_COUNT_NODE))

async function trial(v, waits = [800, 1500, 2500, 4000]) {
  await ev(SET(v))
  const seq = []
  let prev = 0
  for (const w of waits) { await sleep(w - prev); prev = w; seq.push(await ev(READ)) }
  console.log(`  输入 ${JSON.stringify(v).padEnd(16)} → 读数序列 [${seq.join(', ')}]`)
  return seq
}

console.log('\n=== 读数稳定性（同一输入，不同等待时长） ===')
for (const v of ['', 'zzqqxx9988', 'zhangsan', '张三', '马', '李四']) await trial(v)

console.log('\n=== 表格到底是什么结构 ===')
console.log(await ev(`(()=>{
  const cands=[...document.querySelectorAll('div')].filter(d=>{
    const s=getComputedStyle(d); return s.display.includes('grid')||s.display.includes('flex');
  }).length;
  const rows=[...document.querySelectorAll('[role=row],tr,.arco-table-tr,.ui-table-tr,[class*=table-row]')].length;
  const anyCls=[...document.querySelectorAll('[class*=table]')].slice(0,6).map(e=>e.tagName+'.'+(e.className||'').split(' ').slice(0,2).join('.'));
  return JSON.stringify({flexOrGridDivs:cands, rowLike:rows, tableishClasses:anyCls},null,1);
})()`))

console.log('\n=== 成员行长什么样（第 1 行） ===')
console.log(await ev(`(()=>{
  const t=document.body.innerText;
  const i=t.indexOf('zhangsan@internal.example');
  const rows=[...document.querySelectorAll('div,li')].filter(d=>{
    const s=(d.innerText||''); return s.includes('@internal.example') && s.length<300 && d.children.length>1;
  }).slice(0,2);
  return rows.map(r=>'<'+r.tagName+' class="'+(r.className||'').slice(0,60)+'"> '+r.innerText.replace(/\\s+/g,' ').slice(0,120)).join('\\n');
})()`))
pc.close()
