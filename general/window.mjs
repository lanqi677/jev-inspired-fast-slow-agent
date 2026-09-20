#!/usr/bin/env node
/**
 * 浏览器窗口控制 —— 运行时开关可视化监控
 *
 *   node window.mjs info      看当前窗口状态和尺寸
 *   node window.mjs min       最小化（隐藏到任务栏，自动化继续跑）
 *   node window.mjs restore   还原
 *   node window.mjs max       最大化
 *   node window.mjs focus     提到前台
 *   node window.mjs close     关掉浏览器
 *
 * 连的是【浏览器级】CDP 端点（/json/version 的 webSocketDebuggerUrl），
 * 所以和正在跑任务的页面连接互不干扰。
 */
const PORT = Number(process.env.CDP_PORT || 9226)
const CMD = (process.argv[2] || 'info').toLowerCase()

const getJSON = p => new Promise((res, rej) => {
  import('node:http').then(({ default: http }) =>
    http.get({ host: '127.0.0.1', port: PORT, path: p }, r => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } })
    }).on('error', rej))
})

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map(); let seq = 0
    ws.onerror = () => reject(new Error('连不上浏览器调试端口 ' + PORT))
    ws.onopen = () => {
      ws.onmessage = ev => {
        let m; try { m = JSON.parse(ev.data) } catch { return }
        const p = m.id && pending.get(m.id); if (!p) return
        pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
      resolve({
        send: (method, params = {}) => new Promise((res, rej) => {
          const id = ++seq; pending.set(id, { resolve: res, reject: rej })
          ws.send(JSON.stringify({ id, method, params }))
          setTimeout(() => { if (pending.delete(id)) rej(new Error('超时 ' + method)) }, 8000)
        }),
        close: () => ws.close(),
      })
    }
  })
}

const ver = await getJSON('/json/version')
const targets = await getJSON('/json/list')
const page = targets.find(t => t.type === 'page')
const c = await connect(ver.webSocketDebuggerUrl)

if (CMD === 'close') {
  await c.send('Browser.close')
  console.log('已关闭浏览器')
} else if (CMD === 'info') {
  const { windowId, bounds } = await c.send('Browser.getWindowForTarget', { targetId: page?.id })
  console.log('windowId : ' + windowId)
  console.log('状态     : ' + bounds.windowState)
  console.log('位置尺寸 : ' + bounds.left + ',' + bounds.top + '  ' + bounds.width + '×' + bounds.height)
  console.log('页面     : ' + (page ? page.title + '  ' + page.url : '(无)'))
} else {
  const map = { min: 'minimized', minimize: 'minimized', maximize: 'maximized', max: 'maximized', restore: 'normal', normal: 'normal', focus: 'normal' }
  const state = map[CMD]
  if (!state) { console.error('未知命令: ' + CMD); process.exit(1) }
  const { windowId } = await c.send('Browser.getWindowForTarget', { targetId: page?.id })
  if (CMD === 'restore' || CMD === 'focus') {
    // 先 normal 再置前，否则从最小化状态直接置前在某些 WM 上无效
    await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }).catch(() => {})
    await new Promise(r => setTimeout(r, 120))
  }
  await c.send('Browser.setWindowBounds', { windowId, bounds: { windowState: state } })
  const after = await c.send('Browser.getWindowBounds', { windowId })
  console.log('窗口状态 → ' + after.bounds.windowState)
}
c.close()
