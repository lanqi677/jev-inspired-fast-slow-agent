#!/usr/bin/env node
/**
 * 有头模式实测：窗口出现 → 感知 → 最小化 → 再感知 + 点击 → 还原
 * 关键要回答：最小化之后 getBoundingClientRect / click / DOM 查询 还正常吗
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.HOME + '/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome'
const PORT = Number(process.env.CDP_PORT || 9227)
const APP = 'file://' + join(HERE, '..', 'ops_scenario', 'mock_sitea.html') + '?v=dup_email'
const PERCEIVE = readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const getJSON = p => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  }).on('error', rej)
})

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pending = new Map(); let seq = 0
    ws.onerror = () => reject(new Error('ws error'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pending.get(m.id); if (!p) return
        pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      resolve({ send: (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq; pending.set(id, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id, method, params }))
        setTimeout(() => { if (pending.delete(id)) rej(new Error('超时 ' + method)) }, 10000)
      }), close: () => ws.close() })
    }
  })
}

console.log('启动有头 Chrome（窗口会出现在桌面上）…')
const chrome = spawn(CHROME, [
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + join(HERE, '.chrome-headed'),
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1280,860', '--window-position=80,60',
  '--disable-features=Translate,AcceptCHFrame,MediaRouter',
  APP,
], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })
chrome.stderr.on('data', () => {})

let page = null, bc = null, pc = null
try {
  for (let i = 0; i < 60 && !page; i++) { await sleep(300); try { page = (await getJSON('/json/list')).find(t => t.type === 'page' && t.url.startsWith('file://')) } catch {} }
  if (!page) throw new Error('页面没起来')
  const ver = await getJSON('/json/version')
  bc = await connect(ver.webSocketDebuggerUrl)      // 浏览器级：控制窗口
  pc = await connect(page.webSocketDebuggerUrl)     // 页面级：干活
  await pc.send('Runtime.enable'); await pc.send('Page.enable')
  await sleep(900)

  const win = await bc.send('Browser.getWindowForTarget', { targetId: page.id })
  const windowId = win.windowId
  console.log(`窗口已创建  id=${windowId}  state=${win.bounds.windowState}  ${win.bounds.width}×${win.bounds.height}`)

  const probe = `(()=>{
    const r = document.querySelector('#kw')?.getBoundingClientRect();
    return JSON.stringify({
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      innerW: innerWidth, innerH: innerHeight,
      kwRect: r ? [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)] : null
    })
  })()`

  async function examine(tag) {
    const env = JSON.parse(await pc.send('Runtime.evaluate', { expression: probe, returnByValue: true }).then(r => r.result.value))
    const st = JSON.parse(await pc.send('Runtime.evaluate', { expression: PERCEIVE, returnByValue: true }).then(r => r.result.value))
    // 真的点一下：搜工号 → 看结果变化
    await pc.send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector('#kw');e.value='123@123.com';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#go').click();return 1})()`, returnByValue: true })
    await sleep(300)
    const rows = await pc.send('Runtime.evaluate', { expression: `document.querySelectorAll('#result table tbody tr').length`, returnByValue: true }).then(r => r.result.value)
    const clicked = await pc.send('Runtime.evaluate', { expression: `(()=>{const b=document.querySelector('.detail');if(!b)return 'NOBTN';b.click();return 'CLICKED'})()`, returnByValue: true }).then(r => r.result.value)
    await sleep(250)
    const panel = await pc.send('Runtime.evaluate', { expression: `document.querySelector('#panel')?.classList.contains('hidden')===false`, returnByValue: true }).then(r => r.result.value)
    console.log(`\n[${tag}]`)
    console.log(`  document.hidden=${env.hidden}  visibilityState=${env.visibilityState}  hasFocus=${env.hasFocus}  innerW×H=${env.innerW}×${env.innerH}`)
    console.log(`  #kw 的 getBoundingClientRect = ${JSON.stringify(env.kwRect)}`)
    console.log(`  感知层看到的候选元素 = ${st.candidates.length} 个`)
    console.log(`  搜索后结果行数 = ${rows}   点「查看详情」= ${clicked}   详情面板已打开 = ${panel}`)
    return { env, cands: st.candidates.length, rows, clicked, panel }
  }

  const normal = await examine('正常显示')

  console.log('\n>>> 最小化窗口')
  await bc.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  await sleep(1200)
  const b1 = await bc.send('Browser.getWindowBounds', { windowId })
  console.log('    窗口状态 = ' + b1.bounds.windowState)
  const minimized = await examine('已最小化')

  console.log('\n>>> 还原窗口')
  await bc.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  await sleep(900)
  const b2 = await bc.send('Browser.getWindowBounds', { windowId })
  console.log('    窗口状态 = ' + b2.bounds.windowState)
  const restored = await examine('已还原')

  console.log('\n' + '='.repeat(78))
  console.log('结论')
  console.log('-'.repeat(78))
  console.log(`最小化后 document.hidden       : ${minimized.env.hidden}`)
  console.log(`最小化后 元素仍有真实尺寸       : ${minimized.env.kwRect && minimized.env.kwRect[2] > 4 ? '是' : '否'}`)
  console.log(`最小化后 感知层仍能枚举候选     : ${minimized.cands > 0 ? '是 (' + minimized.cands + ' 个)' : '否'}`)
  console.log(`最小化后 搜索/点击仍生效        : ${minimized.rows > 0 && minimized.panel ? '是' : '否'}`)
  console.log(`还原后 一切正常                : ${restored.cands > 0 && restored.panel ? '是' : '否'}`)
  console.log('='.repeat(78))
} finally {
  try { await bc?.send('Browser.close') } catch {}
  try { pc?.close(); bc?.close() } catch {}
  chrome.kill('SIGKILL')
}
