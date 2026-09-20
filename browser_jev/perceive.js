// 感知层：在页面里跑，把界面压成「状态 + 候选元素表」。
// 每跑一次就作废上一轮的编号（重新打 data-jev-snap），从结构上强制"快照不可跨步复用"。
(() => {
  const SNAP = String(Date.now());
  document.querySelectorAll('[data-jev]').forEach(e => e.removeAttribute('data-jev'));

  // ---- 站点适配器（可选）----
  // 没有 window.__ADAPTER__ 时，下面每一项都退回通用启发式，行为与不带适配器时完全一致。
  const AD = (typeof window !== 'undefined' && window.__ADAPTER__) || null;
  const P = (AD && AD.perceive) || {};
  const ROWSEL = P.rowSelector || 'tr,[role=row],li,[class*=table-row],[class*=list-item],[class*=table-tr]';
  const matchRow = el => { try { return el.matches(ROWSEL) } catch (e) { return false } };

  const vis = el => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  };
  const labelOf = el => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.textContent.trim(); } catch (e) {} }
    const lb = el.closest('label'); if (lb) return lb.textContent.trim();
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    return '';
  };
  const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 70);
  // 所在行 / 所在区域：100+ 元素时，没有这个模型分不清"哪个『编辑』按钮"
  const ctxOf = el => {
    let row = null; try { row = el.closest(ROWSEL) } catch (e) {}
    if (row) return clean(row.innerText, 60);
    const box = el.closest('[role=dialog],section,aside,form');
    if (box) { const h = box.querySelector('h1,h2,h3,legend'); if (h) return '区域:' + clean(h.innerText, 24); }
    return '';
  };

  // ---- 状态 ----
  let status = [...document.querySelectorAll('[role=status]')].filter(vis).map(e => clean(e.textContent, 40));
  if (P.statusSelector) {
    try {
      const extra = [...document.querySelectorAll(P.statusSelector)].filter(vis).map(e => clean(e.textContent, 60)).filter(Boolean);
      status = extra.concat(status);
    } catch (e) {}
  }
  // 适配器声明的计数（结果条数）—— 直接进状态，模型也能看到
  let count = null;
  if (AD && AD.count) {
    try {
      const src = AD.count.kind === 'rows'
        ? document.querySelectorAll(AD.count.selector).length + ''
        : ((AD.count.selector ? (document.querySelector(AD.count.selector) || {}).innerText : document.body.innerText) || '');
      const m = String(src).replace(/\s+/g, ' ').match(new RegExp(AD.count.pattern || '(\\d+)'));
      count = m ? Number(m[1]) : (AD.count.kind === 'rows' ? Number(src) : null);
    } catch (e) {}
  }
  const alerts = [...document.querySelectorAll('[role=alert]')].filter(vis).map(e => clean(e.textContent, 120));
  const dialogs = [...document.querySelectorAll('[role=dialog]')].filter(vis).map(e => clean(e.textContent, 160));
  const fields = [];
  document.querySelectorAll('input,select,textarea').forEach(el => {
    if (el.type === 'hidden' || !vis(el)) return;
    fields.push({ name: labelOf(el) || el.name || el.id || '?', value: clean(el.value, 40), enabled: !el.disabled });
  });

  // ---- 候选元素 ----
  const SEL = ['a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[role=row],[onclick],'
    + '[class*=table-row]:not([class*=header]),[class*=list-item],[class*=table-tr]', P.extra || ''].filter(Boolean).join(',');
  const seen = new Set(), cands = [];
  let n = 0;
  let nodes = [];
  try { nodes = [...document.querySelectorAll(SEL)] }
  catch (e) { try { nodes = [...document.querySelectorAll(SEL.split(',')[0])] } catch (e2) { nodes = [] } }
  for (const el of nodes) {
    if (seen.has(el) || !vis(el)) continue;
    seen.add(el);
    if (n >= 300) break;
    const id = 'J' + (++n);
    el.setAttribute('data-jev', id);
    el.setAttribute('data-jev-snap', SNAP);
    const isRow = matchRow(el)
    cands.push({
      id,
      tag: el.tagName.toLowerCase(),
      kind: isRow ? 'row' : el.tagName.toLowerCase() + (el.type ? ':' + el.type : ''),
      name: clean(labelOf(el) || el.getAttribute('title') || '', 40),
      text: clean(el.innerText || el.value || '', 50),
      value: el.tagName === 'SELECT' || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? clean(el.value, 40) : null,
      ctx: isRow ? clean(el.innerText, 80) : ctxOf(el),
      zone: el.closest('[role=dialog]') ? 'panel' : 'page',
      enabled: !el.disabled,
    });
  }

  return JSON.stringify({
    snap: SNAP,
    adapter: AD ? (AD.id || 'adapter') : null,
    count,
    url: location.pathname + location.search,
    title: document.title,
    status, alerts, dialogs, fields,
    candidates: cands,
  });
})()
