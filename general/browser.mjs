#!/usr/bin/env node
/**
 * 常驻浏览器 —— 一个你随时看得见、登录态长期保留的 Chrome
 * 引擎挂上去干活，不再自己开关浏览器
 *
 *   node browser.mjs start [url]   启动（后台常驻，窗口出现在桌面上）
 *   node browser.mjs status        看是否在跑、当前在哪个页面
 *   node browser.mjs goto <url>    切页面
 *   node browser.mjs dump [url]    采集当前页（状态+候选+截图），存 recon_*.{json,png}
 *   node browser.mjs min|restore|max|focus    窗口控制
 *   node browser.mjs stop          关闭
 *
 * 登录：start 之后在窗口里手动登录（脚本不碰你的密码）。chrome profile 会保留会话，
 *       之后只要这个浏览器不关，引擎就不用再登录。
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
// 换设备/换 Chrome 版本不用改代码：CHROME_BIN 直接指定，或 CHROME_VERSION 换版本号
const CHROME = process.env.CHROME_BIN
  || `${process.env.HOME || ''}/.cache/puppeteer/chrome/linux-${process.env.CHROME_VERSION || '152.0.7977.75'}/chrome-linux64/chrome`
const PORT = Number(process.env.CDP_PORT || 9240)
const PROFILE = join(HERE, '.chrome-real')
const PERCEIVE = readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')
const sleep = ms => new Promise(r => setTimeout(r, ms))

const getJSON = p => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 2500 }, r => {
    let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
  }); q.on('error', rej); q.on('timeout', () => q.destroy(new Error('timeout')))
})
const alive = async () => { try { await getJSON('/json/version'); return true } catch { return false } }

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pend = new Map(); let s = 0
    ws.onerror = () => reject(new Error('ws error'))
    ws.onopen = () => {
      ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pend.get(m.id); if (!p) return
        pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) }
      resolve({ send: (me, pa = {}) => new Promise((R, J) => {
        const id = ++s; pend.set(id, { resolve: R, reject: J })
        ws.send(JSON.stringify({ id, method: me, params: pa }))
        setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + me)) }, 30000)
      }), close: () => ws.close() })
    }
  })
}

const CMD = (process.argv[2] || 'status').toLowerCase()
const ARG = process.argv[3]

async function withBrowser(fn) {
  const ver = await getJSON('/json/version')
  const list = await getJSON('/json/list')
  const page = list.find(t => t.type === 'page')
  const bc = await connect(ver.webSocketDebuggerUrl)
  let pc = null
  if (page) { pc = await connect(page.webSocketDebuggerUrl); await pc.send('Runtime.enable'); await pc.send('Page.enable') }
  try { return await fn({ bc, pc, page, ver }) } finally { try { pc?.close(); bc.close() } catch {} }
}

if (CMD === 'start') {
  if (await alive()) { console.log('已经在跑了（端口 ' + PORT + '）'); }
  else {
    if (!existsSync(PROFILE)) mkdirSync(PROFILE, { recursive: true })
    const url = ARG || 'about:blank'
    const c = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1440,900', '--window-position=40,30',
      '--disable-features=Translate,AcceptCHFrame,MediaRouter',
      url], { detached: true, stdio: 'ignore', env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })
    c.unref()
    process.stdout.write('启动中')
    for (let i = 0; i < 50; i++) { await sleep(300); if (await alive()) break; process.stdout.write('.') }
    console.log(await alive() ? '\n浏览器已启动（后台常驻，端口 ' + PORT + '）' : '\n启动失败')
  }
  if (await alive()) {
    const list = await getJSON('/json/list')
    const p = list.find(t => t.type === 'page')
    console.log('当前页面: ' + (p ? p.title + '  ' + p.url : '(无)'))
    console.log('profile : ' + PROFILE + '  （登录态保存在这里）')
  }
} else if (CMD === 'status') {
  if (!await alive()) { console.log('未运行。用: node browser.mjs start <url>'); process.exit(0) }
  await withBrowser(async ({ bc, page }) => {
    const w = await bc.send('Browser.getWindowForTarget', { targetId: page?.id }).catch(() => null)
    console.log('运行中  端口 ' + PORT)
    if (w) console.log('窗口    ' + w.bounds.windowState + '  ' + w.bounds.width + '×' + w.bounds.height)
    console.log('页面    ' + (page ? page.title : '') + '\n        ' + (page ? page.url : ''))
    if (page) {
      const t = (await (await connect(page.webSocketDebuggerUrl)).send('Runtime.evaluate',
        { expression: 'document.body.innerText.replace(/\\s+/g," ").slice(0,160)', returnByValue: true })).result.value
      console.log('正文    ' + t)
    }
  })
} else if (CMD === 'goto') {
  if (!ARG) { console.error('用法: node browser.mjs goto <url>'); process.exit(1) }
  if (!await alive()) { console.error('浏览器没在跑，先 start'); process.exit(1) }
  await withBrowser(async ({ pc }) => {
    await pc.send('Page.navigate', { url: ARG })
    await sleep(3000)
    console.log('已跳转: ' + ARG)
  })
} else if (CMD === 'dump') {
  if (!await alive()) { console.error('浏览器没在跑，先 start'); process.exit(1) }
  await withBrowser(async ({ pc }) => {
    if (ARG) { await pc.send('Page.navigate', { url: ARG }); await sleep(4000) }
    const st = JSON.parse((await pc.send('Runtime.evaluate', { expression: PERCEIVE, returnByValue: true })).result.value)
    const m = JSON.parse((await pc.send('Runtime.evaluate', { expression: `JSON.stringify({url:location.href,title:document.title,
      nInput:document.querySelectorAll('input').length,nBtn:document.querySelectorAll('button').length,
      nIframe:document.querySelectorAll('iframe').length,bodyLen:document.body.innerText.length,
      head:document.body.innerText.replace(/\\s+/g,' ').slice(0,700)})`, returnByValue: true })).result.value)
    console.log('URL      : ' + m.url)
    console.log('标题     : ' + m.title)
    console.log('统计     : input=' + m.nInput + ' button=' + m.nBtn + ' iframe=' + m.nIframe + ' 正文=' + m.bodyLen)
    console.log('状态区   : ' + (st.status.join(' | ') || '(无)'))
    console.log('提示     : ' + (st.alerts.join(' | ') || '(无)'))
    console.log('面板     : ' + (st.dialogs.length ? st.dialogs.join(' | ').slice(0, 180) : '(无)'))
    console.log('字段     : ' + (st.fields.length ? st.fields.map(f => f.name + '=' + f.value).join('  ') : '(无)'))
    console.log('候选元素 : ' + st.candidates.length + ' 个')
    for (const c of st.candidates.slice(0, 30))
      console.log(`  [${c.id.padEnd(4)}] ${(c.kind||'').padEnd(22)} ${(c.name||'').slice(0,22).padEnd(24)} ${(c.text||'').slice(0,28).padEnd(30)} ${c.zone==='panel'?'面板 ':''}${c.enabled?'':'禁用'}${c.ctx?' 行='+c.ctx.slice(0,30):''}`)
    console.log('\n正文前 500 字:\n' + m.head.slice(0, 500))
    const host = (() => { try { return new URL(m.url).hostname } catch { return 'page' } })()
    try {
      const shot = await pc.send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(HERE, `recon_${host}.png`), Buffer.from(shot.data, 'base64'))
      console.log('\n截图: recon_' + host + '.png')
    } catch {}
    writeFileSync(join(HERE, `recon_${host}.json`), JSON.stringify({ meta: m, state: st }, null, 1))
    console.log('状态: recon_' + host + '.json')
  })
} else if (['min', 'minimize', 'restore', 'max', 'maximize', 'focus'].includes(CMD)) {
  if (!await alive()) { console.error('浏览器没在跑'); process.exit(1) }
  await withBrowser(async ({ bc, page }) => {
    const state = { min: 'minimized', minimize: 'minimized', max: 'maximized', maximize: 'maximized', restore: 'normal', focus: 'normal' }[CMD]
    const { windowId } = await bc.send('Browser.getWindowForTarget', { targetId: page.id })
    if (CMD === 'restore' || CMD === 'focus') {
      await bc.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
      await sleep(150)
    }
    await bc.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } })
    const b = await bc.send('Browser.getWindowBounds', { windowId })
    console.log('窗口 → ' + b.bounds.windowState)
  })
} else if (CMD === 'stop') {
  if (!await alive()) { console.log('本来就没在跑'); process.exit(0) }
  await withBrowser(async ({ bc }) => { await bc.send('Browser.close').catch(() => {}) })
  await sleep(800)
  console.log('已关闭（登录态已存进 profile，下次 start 免登录）')
} else {
  console.log('用法: node browser.mjs start|status|goto|dump|min|restore|max|stop [url]')
}
process.exit(0)
