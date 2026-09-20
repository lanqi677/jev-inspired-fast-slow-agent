import { spawn } from 'node:child_process'
import { writeFileSync, appendFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'

const HERE = process.cwd()
const LOG = join(HERE, 'headed_probe.log')
writeFileSync(LOG, '')
const log = m => { console.log(m); appendFileSync(LOG, m + '\n') }

const CHROME = process.env.HOME + '/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome'
const PORT = Number(process.env.PROBE_PORT || 9229)
const APP = 'file://' + join(HERE, '..', 'ops_scenario', 'mock_sitea.html') + '?v=dup_email'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const getJSON = p => new Promise((res, rej) => {
  const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2000 }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  })
  req.on('error', rej); req.on('timeout', () => { req.destroy(new Error('http timeout')) })
})

log('CHROME = ' + CHROME)
log('DISPLAY = ' + (process.env.DISPLAY || ':0'))
const c = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(HERE, '.chrome-h1'),
  '--window-size=1280,860', '--window-position=80,60', APP],
  { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })
c.stderr.on('data', d => appendFileSync(LOG, '[chrome] ' + d))
c.on('exit', (code, sig) => log(`[chrome 退出] code=${code} sig=${sig}`))
log('1) 已 spawn pid=' + c.pid)

let list = null
for (let i = 0; i < 40 && !list; i++) {
  await sleep(300)
  try { const l = await getJSON('/json/list'); if (l && l.length) list = l } catch (e) {}
}
log('2) /json/list = ' + (list ? list.map(t => t.type).join(',') : '拿不到'))

if (list) {
  const page = list.find(t => t.type === 'page' && t.url.startsWith('file://'))
  log('3) file 页面 target = ' + (page ? page.id : '(没有)'))
  const ver = await getJSON('/json/version')
  log('4) 浏览器 ws = ' + ver.webSocketDebuggerUrl.slice(0, 56))

  const conn = url => new Promise((res, rej) => {
    const ws = new WebSocket(url); const pend = new Map(); let s = 0
    ws.onerror = () => rej(new Error('ws error'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pend.get(m.id); if (!p) return
        pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      res({ send: (me, pa = {}) => new Promise((R, J) => {
        const id = ++s; pend.set(id, { resolve: R, reject: J })
        ws.send(JSON.stringify({ id, method: me, params: pa }))
        setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + me)) }, 8000)
      }), close: () => ws.close() })
    }
  })
  const bc = await conn(ver.webSocketDebuggerUrl)
  log('5) 浏览器级 CDP 已连')
  const w = await bc.send('Browser.getWindowForTarget', { targetId: page.id })
  log('6) getWindowForTarget → ' + JSON.stringify(w))
  await bc.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } })
  await sleep(900)
  const g = await bc.send('Browser.getWindowBounds', { windowId: w.windowId })
  log('7) 最小化后状态 → ' + JSON.stringify(g.bounds))
  await bc.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } })
  await sleep(700)
  const g2 = await bc.send('Browser.getWindowBounds', { windowId: w.windowId })
  log('8) 还原后状态 → ' + JSON.stringify(g2.bounds))

  const pc = await conn(page.webSocketDebuggerUrl)
  await pc.send('Runtime.enable')
  await sleep(600)
  log('9) 页面级 CDP 已连')
  await bc.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } })
  await sleep(1200)
  const probe = `(()=>{const r=document.querySelector('#kw')?.getBoundingClientRect();return JSON.stringify({hidden:document.hidden,vis:document.visibilityState,focus:document.hasFocus(),w:innerWidth,h:innerHeight,rect:r?[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]:null})})()`
  const env = JSON.parse((await pc.send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value)
  log('10) 【最小化中】' + JSON.stringify(env))
  const before = (await pc.send('Runtime.evaluate', { expression: `document.querySelectorAll('#result table tbody tr').length`, returnByValue: true })).result.value
  await pc.send('Runtime.evaluate', { expression: `(()=>{const e=document.querySelector('#kw');e.value='123@123.com';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#go').click();return 1})()`, returnByValue: true })
  await sleep(400)
  const after = (await pc.send('Runtime.evaluate', { expression: `document.querySelectorAll('#result table tbody tr').length`, returnByValue: true })).result.value
  const clicked = (await pc.send('Runtime.evaluate', { expression: `(()=>{const b=document.querySelector('.detail');if(!b)return 'NOBTN';b.click();return 'OK'})()`, returnByValue: true })).result.value
  await sleep(300)
  const panel = (await pc.send('Runtime.evaluate', { expression: `!document.querySelector('#panel').classList.contains('hidden')`, returnByValue: true })).result.value
  log(`11) 【最小化中】搜索前 ${before} 行 → 搜索后 ${after} 行；点详情=${clicked}；面板已开=${panel}`)

  await bc.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } })
  await sleep(800)
  const env2 = JSON.parse((await pc.send('Runtime.evaluate', { expression: probe, returnByValue: true })).result.value)
  log('12) 【还原后】' + JSON.stringify(env2))
  await bc.send('Browser.close').catch(() => {})
} else {
  log('stderr 摘要: ' + require('fs').readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('[chrome]')).slice(0, 8).join(' | '))
}
c.kill('SIGKILL')
log('=== 结束 ===')
process.exit(0)
