#!/usr/bin/env node
/**
 * 真实页面侦察 —— 先看清页面，再谈自动化
 *
 *   node recon.mjs <url> [等待毫秒]
 *   环境变量:
 *     KEEP=1      跑完不关浏览器，按回车重新采集一次（用来手动登录后复看）
 *     SHOT=1      截图存 PNG（默认开）
 *     DISPLAY     默认 :0
 *
 * 输出: recon_<host>.json + recon_<host>.png，并把要点打到屏幕上
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import readline from 'node:readline'

const HERE = dirname(fileURLToPath(import.meta.url))
const CHROME = process.env.HOME + '/.cache/puppeteer/chrome/linux-152.0.7977.75/chrome-linux64/chrome'
const PORT = Number(process.env.CDP_PORT || 9240)
const PERCEIVE = readFileSync(join(HERE, '..', 'browser_jev', 'perceive.js'), 'utf8')
const URL_ = process.argv[2]
const SETTLE = Number(process.argv[3] || 6000)
if (!URL_) { console.error('用法: node recon.mjs <url> [等待毫秒]'); process.exit(1) }
const HOST = new URL(URL_).hostname
const sleep = ms => new Promise(r => setTimeout(r, ms))

const getJSON = p => new Promise((res, rej) => {
  const q = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, r => {
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
      resolve({ send: (me, pa = {}) => new Promise((R, J) => {
        const id = ++s; pend.set(id, { resolve: R, reject: J })
        ws.send(JSON.stringify({ id, method: me, params: pa }))
        setTimeout(() => { if (pend.delete(id)) J(new Error('timeout ' + me)) }, 30000)
      }), close: () => ws.close() })
    }
  })
}

console.log('打开有头浏览器 → ' + URL_)
const chrome = spawn(CHROME, ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + join(HERE, '.chrome-real'),
  '--window-size=1440,900', '--window-position=40,30', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' } })

let pc = null
try {
  let page = null
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(300)
    try { page = (await getJSON('/json/list')).find(t => t.type === 'page') } catch {}
  }
  if (!page) throw new Error('浏览器没起来')
  pc = await connect(page.webSocketDebuggerUrl)
  await pc.send('Runtime.enable'); await pc.send('Page.enable')

  async function navigate() {
    await pc.send('Page.navigate', { url: URL_ })
    for (let i = 0; i < 60; i++) { await sleep(250); if ((await pc.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true })).result.value === 'complete') break }
    await sleep(SETTLE)
  }

  async function grab(tag) {
    const st = JSON.parse((await pc.send('Runtime.evaluate', { expression: PERCEIVE, returnByValue: true })).result.value)
    const meta = (await pc.send('Runtime.evaluate', {
      expression: `JSON.stringify({url:location.href,title:document.title,ready:document.readyState,
        nInput:document.querySelectorAll('input').length,nBtn:document.querySelectorAll('button').length,
        nIframe:document.querySelectorAll('iframe').length,
        bodyLen:document.body.innerText.length,
        head:document.body.innerText.replace(/\\s+/g,' ').slice(0,700)})`, returnByValue: true })).result.value
    const m = JSON.parse(meta)

    console.log('\n' + '═'.repeat(90))
    console.log(`【${tag}】`)
    console.log('─'.repeat(90))
    console.log('URL        : ' + m.url)
    console.log('标题       : ' + m.title)
    console.log('readyState : ' + m.ready)
    console.log('元素统计   : input=' + m.nInput + '  button=' + m.nBtn + '  iframe=' + m.nIframe + '  正文长度=' + m.bodyLen)
    console.log('状态区     : ' + (st.status.join(' | ') || '(无)'))
    console.log('提示       : ' + (st.alerts.join(' | ') || '(无)'))
    console.log('面板/弹窗  : ' + (st.dialogs.length ? st.dialogs.join(' | ').slice(0, 200) : '(无)'))
    console.log('表单字段   : ' + (st.fields.length ? st.fields.map(f => f.name + '=' + f.value).join('  ') : '(无)'))
    console.log('候选元素   : ' + st.candidates.length + ' 个')
    console.log('\n前 25 个候选:')
    for (const c of st.candidates.slice(0, 25)) {
      console.log(`  [${c.id.padEnd(4)}] ${(c.kind || '').padEnd(22)} ${(c.name || '').slice(0, 24).padEnd(26)} ${(c.text || '').slice(0, 30).padEnd(32)} ${c.zone === 'panel' ? '面板 ' : ''}${c.enabled ? '' : '禁用'}${c.ctx ? ' 行=' + c.ctx.slice(0, 34) : ''}`)
    }
    console.log('\n正文前 500 字:\n' + m.head.slice(0, 500))

    if (process.env.SHOT !== '0') {
      try {
        const shot = await pc.send('Page.captureScreenshot', { format: 'png' })
        const f = join(HERE, `recon_${HOST}.png`)
        writeFileSync(f, Buffer.from(shot.data, 'base64'))
        console.log('\n截图: ' + f)
      } catch (e) { console.log('截图失败: ' + e.message) }
    }
    const jf = join(HERE, `recon_${HOST}.json`)
    writeFileSync(jf, JSON.stringify({ tag, meta: m, state: st }, null, 1))
    console.log('状态: ' + jf)
    return st
  }

  await navigate()
  await grab('首次打开')

  if (process.env.KEEP === '1') {
    console.log('\n' + '─'.repeat(90))
    console.log('浏览器保持打开。如果你需要手动登录 / 切换页面，现在去操作。')
    console.log('完成后回到这里按【回车】重新采集一次（输入 q 回车则退出）…')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    for (;;) {
      const ans = await new Promise(r => rl.question('> ', r))
      if (String(ans).trim().toLowerCase() === 'q') break
      await grab('手动操作后')
      console.log('\n再按回车复采，或 q 退出…')
    }
    rl.close()
  }
} finally {
  try { await pc?.close() } catch {}
  chrome.kill('SIGKILL')
  console.log('浏览器已关闭')
}
