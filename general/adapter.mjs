#!/usr/bin/env node
/**
 * 适配器层 —— 「任意环境 → 统一表示」的可插拔实现
 *
 * 这是三层里的第二层。第一层（引擎）只消费【统一表示】，它不知道背后是 DOM、
 * 是棋盘、还是方向盘。第三层（描述）只讲任务，不讲界面。
 *
 * ── 统一表示（引擎唯一认识的东西）──────────────────────────────
 *   { state: "<紧凑文字>",  options: [ {id, kind, label, meta, enabled} ] }
 *
 * ── 适配器四件套 ──────────────────────────────────────────────
 *   ① 状态编码   perceive.probe / 通用感知 + 适配器规则
 *   ② 可选项     同上
 *   ③ 动作执行   execute
 *   ④ 终止判定   done（游戏用；网页任务用规则表）
 *
 * ── 两种形态 ─────────────────────────────────────────────────
 *   dom     纯数据：选择器 + 正则。网页后台属于这种。
 *   custom  带一小段代码：probe 返回统一表示，execute 执行动作。
 *           游戏 / 车辆属于这种 —— 状态是高维连续量，没有"元素"可言。
 *
 * 关键：代码只出现在【环境这一侧】。引擎里没有一行站点专有代码。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ADAPTER_DIR = process.env.ADAPTER_DIR || join(HERE, 'adapters')

/* ============================ 装载 ============================ */
export function listAdapters() {
  try { return readdirSync(ADAPTER_DIR).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort() }
  catch { return [] }
}

export function loadAdapter(ref) {
  if (!ref) return null
  let p = ref
  if (isAbsolute(p)) { /* 原样 */ }
  else if (p.includes('/')) p = join(process.cwd(), p)
  else p = join(ADAPTER_DIR, p.endsWith('.json') ? p : p + '.json')
  if (!existsSync(p)) throw new Error(`适配器不存在: ${p}\n  可用: ${listAdapters().join(', ') || '(空)'}`)
  const a = JSON.parse(readFileSync(p, 'utf8'))
  a.__path = p
  if (!a.kind) a.kind = 'dom'
  if (!a.id) a.id = p.split('/').pop().replace(/\.json$/, '')
  return a
}

export const describeAdapter = a => a
  ? `${a.id}  [${a.kind}]  ${a.name || ''}${a.host ? '  @' + a.host : ''}`
  : '(无适配器 → 通用启发式)'

/* ============================ ① 感知 ============================ */
// 把适配器注入页面再跑通用感知脚本。
// 没有适配器时【删掉】全局变量，保证默认行为与不加适配器时逐字节一致（零回归）。
export function perceiveExpr(adapter, perceiveSrc) {
  const pre = adapter
    ? `window.__ADAPTER__=${JSON.stringify(adapter)};\n`
    : `try{delete window.__ADAPTER__}catch(e){window.__ADAPTER__=undefined}\n`
  if (adapter && adapter.kind === 'custom' && adapter.probe) {
    // custom 型：探针自己返回统一表示，通用感知不参与
    return pre + `(()=>{const __R__=${adapter.probe};return typeof __R__==='string'?__R__:JSON.stringify(__R__)})()`
  }
  return pre + perceiveSrc
}

/* ============================ 代码事实 ============================ */
// ② 计数：适配器给了规则就用规则（代码算，不调模型）
export function countExpr(adapter) {
  const c = adapter?.count
  if (!c) return null
  if (c.kind === 'rows') {
    return `(()=>{try{return document.querySelectorAll(${JSON.stringify(c.selector)}).length}catch(e){return null}})()`
  }
  const sel = c.selector ? `document.querySelector(${JSON.stringify(c.selector)}).innerText` : `document.body.innerText`
  const guard = c.selector ? `{const __e=document.querySelector(${JSON.stringify(c.selector)});if(!__e)return null;}` : ''
  return `(()=>{${guard}
    const __t=(${sel}||'').replace(/\\s+/g,' ');
    const __m=__t.match(new RegExp(${JSON.stringify(c.pattern)}));
    return __m?Number(__m[1]):null})()`
}

// 读取字段用的文本作用域（适配器可指定，默认：最后一个可见 dialog，否则 body）
export function textExpr(adapter) {
  const s = adapter?.textScope
  if (s?.selector) {
    return `(()=>{const __e=document.querySelector(${JSON.stringify(s.selector)});return (__e?__e.innerText:'').replace(/\\s+/g,' ').slice(0,${s.max || 4000})})()`
  }
  if (s?.all) return `document.body.innerText.replace(/\\s+/g,' ').slice(0,${s.max || 4000})`
  return `(()=>{
    const __vis=e=>{const s=getComputedStyle(e);if(s.display==='none'||s.visibility==='hidden')return false;
      const r=e.getBoundingClientRect();return r.width>10&&r.height>10};
    const __ds=[...document.querySelectorAll('[role=dialog]')].filter(__vis);
    const __p=__ds[__ds.length-1];
    return (__p?__p.innerText:document.body.innerText).replace(/\\s+/g,' ').slice(0,${s?.max || 1500});
  })()`
}

// 字段正则：直接命中，或经 fieldAliases 归一（「信息更新时间」→「更新日期」）
export function fieldRegex(adapter, name) {
  const f = adapter?.fields || {}
  if (f[name]) return f[name]
  const al = adapter?.fieldAliases || {}
  const tgt = al[name]
  if (tgt && f[tgt]) return f[tgt]
  return null
}

// 在【Node 侧】用适配器正则抽字段 —— 零模型调用，值逐字来自原文
export function extractByAdapter(adapter, name, text) {
  const pat = fieldRegex(adapter, name)
  if (!pat) return { ok: false, reason: '适配器里没有这个字段的正则' }
  let m
  try { m = String(text || '').match(new RegExp(pat)) } catch (e) { return { ok: false, reason: '正则非法: ' + e.message } }
  if (!m) return { ok: false, reason: '页面文字里没匹配到' }
  const v = (m[1] !== undefined ? m[1] : m[0]).trim()
  return { ok: true, value: v }
}

/* ============================ ③ 动作执行 ============================ */
/**
 * 返回一段页面侧 JS，执行动作并返回 'OK' / 其它错误码。
 *   dom 型（默认）：靠感知层打的 data-jev 编号 → 引擎不需要知道任何选择器
 *   custom 型：适配器给模板，动作对象以 __ACT__ 注入
 */
export function executeExpr(adapter, act, id) {
  if (adapter?.kind === 'custom' && adapter.execute) {
    const body = adapter.execute[act.do] || adapter.execute.default
    if (body) {
      // 模板是【函数体】，里面可直接用 __ACT__（动作对象）和 __ID__（选项编号）
      return `(()=>{try{
        const __ACT__=${JSON.stringify(act)};
        const __ID__=${JSON.stringify(id)};
        const __R__=(()=>{${body}})();
        return __R__===undefined?'OK':__R__;
      }catch(e){return 'ERR:'+(e&&e.message||e)}})()`
    }
  }
  // dom 型
  // fill 必须用【原生 value setter】—— React/Vue 会覆盖 value 属性，
  // 直接 e.value=x 只改 DOM 不改框架状态，界面看着变了但查询条件没变（静默失败！）
  if (act.do === 'fill') return `(()=>{const e=document.querySelector('[data-jev="${id}"]');if(!e)return 'NOEL';e.focus();
    try{const proto=(e.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement).prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(e,${JSON.stringify(act.text ?? '')});}
    catch(err){e.value=${JSON.stringify(act.text ?? '')}}
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    return 'OK'})()`
  if (act.do === 'select') return `(()=>{const e=document.querySelector('[data-jev="${id}"]');if(!e)return 'NOEL';e.value=${JSON.stringify(act.option ?? '')};e.dispatchEvent(new Event('change',{bubbles:true}));return 'OK'})()`
  if (act.do === 'press') return `(()=>{const e=document.querySelector('[data-jev="${id}"]');const t=e||document.body;t.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(act.key ?? '')},bubbles:true}));return 'OK'})()`
  // 适配器可以覆盖 click
  if (adapter?.click) return `(()=>{const e=document.querySelector('[data-jev="${id}"]');if(!e)return 'NOEL';try{${adapter.click}}catch(err){};e.click();return 'OK'})()`
  return `(()=>{const e=document.querySelector('[data-jev="${id}"]');if(!e)return 'NOEL';e.click();return 'OK'})()`
}

/* ============================ 离线 / 演示 ============================ */
/**
 * 真实地址 → 等价的本地 mock 页。
 * 【哪个域名对哪个 mock 文件】写在 mocks.json 里，是数据不是代码 ——
 * 所以引擎里没有"SiteA"、"SiteB"这类字眼，加一个新站点只需要加一行数据。
 */
let MOCKS = null
export function loadMocks() {
  if (MOCKS === null) {
    const p = join(HERE, 'mocks.json')
    MOCKS = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
  }
  return MOCKS
}
export function resolveMock(url, env = process.env) {
  for (const [envKey, m] of Object.entries(loadMocks())) {
    if (envKey.startsWith('_') || !m || !m.match) continue
    if (new RegExp(m.match, 'i').test(url)) {
      const v = env[envKey] || m.default || ''
      return 'file://' + join(HERE, m.file) + (v ? '?v=' + encodeURIComponent(v) : '')
    }
  }
  return null
}

/* ============================ ④ 等待 ============================ */// 网页有防抖：输入后结果不是立刻出来。适配器声明怎么等。
export function waitSpec(adapter, act) {
  const w = adapter?.wait || {}
  if (act?.do === 'fill') return { strategy: w.strategy || 'sleep', ms: w.afterFillMs ?? w.settleMs ?? 60, ...w }
  if (act?.do === 'click' || act?.do === 'press') return { strategy: w.strategy || 'sleep', ms: w.afterClickMs ?? w.settleMs ?? 260, ...w }
  return { strategy: 'sleep', ms: w.settleMs ?? 260 }
}

/* ============================ 终止判定 ============================ */
// 游戏用：环境自己说"死了/赢了"。网页任务不用这个（规则表负责）。
export function doneExpr(adapter) {
  if (adapter?.kind === 'custom' && adapter.done) return adapter.done
  return null
}
