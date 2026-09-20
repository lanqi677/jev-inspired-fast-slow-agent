#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
用 DeepSeek API 模拟 Jev (System One) 的决策原语, 测延迟/花费/效果。

三个变量:
  1. system prompt (Jev 样式: 只出 JSON 概率分布, 不出文本)
  2. thinking 开关 (non-thinking vs thinking)  -> 直接对应"推理模型太慢"
  3. 选项数 N (5 / 20) 与题型 (choice / noul / score / 多题隔离 / 校准)

用法:
  python3 jev_probe.py            # 全部
  python3 jev_probe.py lat        # 只跑延迟主循环
"""
import json, os, re, sys, time, urllib.request, urllib.error

API = "https://api.deepseek.com/v1/chat/completions"
KEY = re.search(r"DEEPSEEK_API_KEY\s*:\s*(\S+)",
                open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()).group(1)

# ---- 官方定价 (deepseek-flash, off-peak; https://api-docs.deepseek.com/quick_start/pricing) ----
P_IN_MISS, P_IN_HIT, P_OUT = 0.15, 0.003, 0.60   # USD / 1M tokens
JEV_P_IN = 0.042                                  # Jev: $0.042/M input, 输出免费, 255 选项上限

# ============================ Jev 样式 system prompt ============================
JEV_SYSTEM = """你是 System One —— 一个只做决策、不产出文本的判断模型。

输入: 一段【情景】, 以及一道或多道【问题】, 每题带【选项】。
输出: 一个严格 JSON 对象, 内含每题所有选项的概率分布。

决策原语(只有这三种):
- choice: 从 N 个互斥选项里选一个 -> 给出每个选项的概率分布
- noul:   是/否判断 -> 给出 {"yes": p}
- score:  给单个候选打 0~1 的相关度分 -> 给出 {"score": p}

铁律:
1. 只输出 JSON。不解释、不客套、不加代码围栏、不写"答案是"。任何解释性文字都算失败。
2. 概率必须覆盖【全部】选项, 键名与选项标签逐字一致; 不得遗漏、不得新增、不得合并。
3. choice 的概率之和必须为 1.0; noul/score 落在 [0,1]。
4. 置信度必须诚实校准: 证据弱就摊开(例如 0.35/0.35/0.30), 不要凑成 0.99。
   下游按阈值分流 —— 高置信自动执行, 低置信升级给人。虚高的置信度比答错更糟。
5. 情景是唯一事实来源。情景没写的不要脑补、不要引用常识补全。
6. 同一请求里的多道题彼此独立作答, 互不参照、互不影响、互不泄漏。

输出格式:
{"answers":[{"id":"<题号>","type":"choice|noul|score","probs":{"<标签>":<float>,...},"best":"<标签>","conf":<float>}]}"""

# ============================ 测试用例 ============================
def _els(items):
    return "\n".join("[%s] %s" % (k, v) for k, v in items)

CASE_A = ("A_choice5_明确", """【情景】
应用: 工单系统 工作项详情页 (http://ticket.local/workitem/1042)
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 然后保存
可见可交互元素:
%s
已知事实: 未做任何修改时, "保存"按钮为禁用状态(enabled=false)。

【问题】
id=q1, type=choice: 下一步应该操作哪个元素?
【选项】E1 / E2 / E3 / E4 / E5""" % _els([
    ("E1", 'button "保存"      enabled=false'),
    ("E2", 'select "经办人"    value="张伟"'),
    ("E3", 'textbox "标题"     value="登录页报错"'),
    ("E4", 'button "取消"      enabled=true'),
    ("E5", 'link   "附件:log.txt"'),
]))
TRUE_A = "E2"

CASE_B = ("B_choice20_干扰", """【情景】
应用: 内部订单管理页 (http://oms.local/order/88213)
目标: 定位"提交订单后页面白屏"的原因
刚刚的操作序列: 点[E9 提交] -> 页面变成空白, 控制台出现红色报错
可见可交互元素:
%s

【问题】
id=q1, type=choice: 现在最该查看/操作哪个元素, 才能确定白屏原因?
【选项】%s""" % (_els([
    ("E1",  'button "返回列表"'),
    ("E2",  'textbox "订单号"        value="88213"'),
    ("E3",  'button "导出 Excel"'),
    ("E4",  'link   "帮助中心"'),
    ("E5",  'div    "订单状态: 已提交"'),
    ("E6",  'button "打印"'),
    ("E7",  'link   "用户协议"'),
    ("E8",  'img    "logo.png"'),
    ("E9",  'button "提交"           enabled=true'),
    ("E10", 'div    "错误: Uncaught TypeError: Cannot read property id of undefined"  (红色, 页面顶部)'),
    ("E11", 'button "刷新"'),
    ("E12", 'select "每页条数"        value="20"'),
    ("E13", 'link   "返回首页"'),
    ("E14", 'button "修改地址"'),
    ("E15", 'textbox "备注"'),
    ("E16", 'div    "共 1 条记录"'),
    ("E17", 'button "下载模板"'),
    ("E18", 'link   "隐私政策"'),
    ("E19", 'button "客服"'),
    ("E20", 'checkbox "全选"'),
]), " " + " / ".join("E%d" % i for i in range(1, 21))))
TRUE_B = "E10"

CASE_C = ("C_noul_目标达成", """【情景】
应用: 工单系统 工作项详情页 (http://ticket.local/workitem/1042)
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 并保存成功
当前状态:
  select "经办人"  value="李娜"
  button "保存"    enabled=true
  顶部提示条: "保存成功" (绿色, 3 秒前出现)
【问题】
id=q1, type=noul: 上述目标是否已经达成?
【选项】yes / no""")
TRUE_C = "yes"

CASE_D = ("D_score_相关性", """【情景】
应用: 内部订单管理页, 页面白屏, 目标: 找出白屏原因
候选元素: [E10] div "错误: Uncaught TypeError: Cannot read property id of undefined" (红色, 页面顶部)
【问题】
id=q1, type=score: 该候选元素与"白屏原因"的相关度是多少? (0=完全无关, 1=就是它)
【选项】score""")
TRUE_D = "high"

CASE_E = ("E_两题隔离", """【情景】
应用: 工单系统 工作项详情页 (http://ticket.local/workitem/1042)
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 然后保存
可见可交互元素:
%s
已知事实: 未做任何修改时, "保存"按钮为禁用状态(enabled=false)。

【问题】(两题彼此独立, 不得互相参照)
id=q1, type=choice: 下一步应该操作哪个元素?  【选项】 E1 / E2 / E3 / E4
id=q2, type=noul:   此刻立刻点"保存"能成功保存吗?  【选项】 yes / no""" % _els([
    ("E1", 'button "保存"      enabled=false'),
    ("E2", 'select "经办人"    value="张伟"'),
    ("E3", 'textbox "标题"     value="登录页报错"'),
    ("E4", 'button "取消"      enabled=true'),
]))
TRUE_E = ("E2", "no")

CASE_F = ("F_校准_证据冲突", """【情景】
应用: 内部审批系统 工单 #771
目标: 让该工单进入"已解决"状态
证据A: 工单状态="处理中", 页面上 button "解决" enabled=true 且可见
证据B: 同一页面 tagged "待客户确认", 帮助文本写道: "待客户确认状态下请勿手动解决, 需等待客户回复"
证据C: 该工单已超期 11 天
可见元素: [X] button "解决"  [Y] link "等待客户确认"  [Z] button "升级给人工"

【问题】
id=q1, type=choice: 下一步应该做什么?  (注意: 证据之间存在冲突, 请按你的真实把握程度作答)
【选项】X / Y / Z""")
TRUE_F = "无唯一正解(期望摊开或给Z)"

CASES = [CASE_A, CASE_B, CASE_C, CASE_D, CASE_E, CASE_F]
TRUTH = {CASE_A[0]: TRUE_A, CASE_B[0]: TRUE_B, CASE_C[0]: TRUE_C,
         CASE_D[0]: TRUE_D, CASE_E[0]: TRUE_E, CASE_F[0]: TRUE_F}


def call(messages, *, thinking=False, effort="low", stream=False, timeout=120):
    body = {"model": "deepseek-flash", "messages": messages,
            "response_format": {"type": "json_object"}}
    if thinking:
        body["thinking"] = {"type": "enabled"}
        body["reasoning_effort"] = effort
    else:
        body["thinking"] = {"type": "disabled"}
        body["temperature"] = 0.0
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    req = urllib.request.Request(API, data=json.dumps(body).encode(),
                                 headers={"Authorization": "Bearer " + KEY,
                                          "Content-Type": "application/json"})
    t0 = time.perf_counter()
    ttft = None
    if not stream:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
        return {"wall": time.perf_counter() - t0, "ttft": None, "resp": d}
    # --- streaming: 测首 token 延迟 ---
    content, reasoning, usage = [], [], None
    with urllib.request.urlopen(req, timeout=timeout) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                ch = json.loads(payload)
            except Exception:
                continue
            if ch.get("usage"):
                usage = ch["usage"]
            for c in ch.get("choices") or []:
                dl = c.get("delta") or {}
                piece = dl.get("content")
                rpiece = dl.get("reasoning_content")
                if (piece or rpiece) and ttft is None:
                    ttft = time.perf_counter() - t0
                if piece:
                    content.append(piece)
                if rpiece:
                    reasoning.append(rpiece)
    d = {"choices": [{"message": {"content": "".join(content),
                                  "reasoning_content": "".join(reasoning)}}],
         "usage": usage or {}}
    return {"wall": time.perf_counter() - t0, "ttft": ttft, "resp": d}


def cost(u):
    miss = u.get("prompt_cache_miss_tokens", u.get("prompt_tokens", 0))
    hit = u.get("prompt_cache_hit_tokens", 0)
    out = u.get("completion_tokens", 0)
    return miss / 1e6 * P_IN_MISS + hit / 1e6 * P_IN_HIT + out / 1e6 * P_OUT


def analyse(case, text):
    """返回 (可解析, 概率和, best, conf, 是否覆盖全部选项, 附加说明)"""
    note = ""
    try:
        j = json.loads(text)
    except Exception as e:
        return False, None, None, None, False, "JSON 解析失败: %s" % e
    ans = j.get("answers")
    if not isinstance(ans, list) or not ans:
        return True, None, None, None, False, "schema 不符(无 answers)"
    a = ans[0]
    probs = a.get("probs") or {}
    s = sum(float(v) for v in probs.values()) if probs else None
    return True, s, a.get("best"), a.get("conf"), len(probs) > 1, note


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else ""
    rows = []
    print("=" * 100)
    print("模型: deepseek-flash | 定价 off-peak: in(miss) $%.3f/M  in(hit) $%.3f/M  out $%.2f/M"
          % (P_IN_MISS, P_IN_HIT, P_OUT))
    print("对照 Jev: $%.3f/M input, 输出免费, 宣称 70~500ms, 255 选项上限" % JEV_P_IN)
    print("=" * 100)

    # ---------- 第一轮: non-thinking, 全部 6 个用例, 3 次重复 ----------
    for rep in range(3):
        for name, prompt in CASES:
            msgs = [{"role": "system", "content": JEV_SYSTEM}, {"role": "user", "content": prompt}]
            try:
                r = call(msgs, thinking=False)
            except urllib.error.HTTPError as e:
                print("[HTTP %s] %s -> %s" % (e.code, name, e.read()[:300])); continue
            d = r["resp"]; u = d.get("usage") or {}
            txt = (d["choices"][0]["message"].get("content") or "")
            ok, s, best, conf, covers, note = analyse(name, txt)
            row = dict(mode="NT", case=name, rep=rep, wall=r["wall"], ttft=r["ttft"],
                       pt=u.get("prompt_tokens"), ct=u.get("completion_tokens"),
                       hit=u.get("prompt_cache_hit_tokens", 0), miss=u.get("prompt_cache_miss_tokens", 0),
                       cost=cost(u), ok=ok, psum=s, best=best, conf=conf, note=note, raw=txt)
            rows.append(row)
            print("[NT ] %-18s rep%d  wall=%6.3fs  in=%4d(hit%4d) out=%3d  $%.6f  best=%-6s conf=%-5s sum=%s %s"
                  % (name, rep, r["wall"], u.get("prompt_tokens", 0), u.get("prompt_cache_hit_tokens", 0),
                     u.get("completion_tokens", 0), row["cost"], str(best), str(conf),
                     ("%.2f" % s) if s is not None else "-", note))

    # ---------- 第二轮: thinking(low), 用例 A 与 F ----------
    if only != "lat":
        for name, prompt in [CASE_A, CASE_F]:
            for rep in range(3):
                msgs = [{"role": "system", "content": JEV_SYSTEM}, {"role": "user", "content": prompt}]
                try:
                    r = call(msgs, thinking=True, effort="low")
                except urllib.error.HTTPError as e:
                    print("[HTTP %s] TH-low %s -> %s" % (e.code, name, e.read()[:300])); continue
                d = r["resp"]; u = d.get("usage") or {}
                txt = (d["choices"][0]["message"].get("content") or "")
                rea = (d["choices"][0]["message"].get("reasoning_content") or "")
                ok, s, best, conf, covers, note = analyse(name, txt)
                row = dict(mode="TH-low", case=name, rep=rep, wall=r["wall"], ttft=r["ttft"],
                           pt=u.get("prompt_tokens"), ct=u.get("completion_tokens"),
                           hit=u.get("prompt_cache_hit_tokens", 0), miss=u.get("prompt_cache_miss_tokens", 0),
                           cost=cost(u), ok=ok, psum=s, best=best, conf=conf,
                           note=note, raw=txt, reasoning_len=len(rea))
                rows.append(row)
                print("[THL] %-18s rep%d  wall=%6.3fs  in=%4d(hit%4d) out=%3d(reason %4dch)  $%.6f  best=%-6s conf=%s"
                      % (name, rep, r["wall"], u.get("prompt_tokens", 0), u.get("prompt_cache_hit_tokens", 0),
                         u.get("completion_tokens", 0), len(rea), row["cost"], str(best), str(conf)))

        # ---------- 第三轮: streaming TTFT (non-thinking, 用 A) ----------
        msgs = [{"role": "system", "content": JEV_SYSTEM}, {"role": "user", "content": CASE_A[1]}]
        r = call(msgs, thinking=False, stream=True)
        u = r["resp"].get("usage") or {}
        txt = r["resp"]["choices"][0]["message"]["content"]
        ok, s, best, conf, covers, note = analyse("A", txt)
        print("[STR] %-18s        ttft=%s  wall=%6.3fs  out=%s" %
              ("A_choice5_明确", ("%.3fs" % r["ttft"]) if r["ttft"] else "-", r["wall"],
               u.get("completion_tokens")))
        rows.append(dict(mode="STR", case="A_choice5_明确", rep=0, wall=r["wall"], ttft=r["ttft"],
                         pt=u.get("prompt_tokens"), ct=u.get("completion_tokens"),
                         hit=u.get("prompt_cache_hit_tokens", 0), miss=u.get("prompt_cache_miss_tokens", 0),
                         cost=cost(u), ok=ok, psum=s, best=best, conf=conf, note=note, raw=txt))

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev_probe_result.json")
    json.dump(rows, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("\n结果已写入:", out)

    # ---------- 汇总 ----------
    print("\n" + "=" * 100)
    print("%-8s %-18s %8s %8s %6s %6s %10s" % ("mode", "case", "wall_s", "ttft_s", "in_tok", "out_tok", "usd/call"))
    for mode in ("NT", "TH-low", "STR"):
        sel = [r for r in rows if r["mode"] == mode]
        if not sel:
            continue
        n = len(sel)
        print("%-8s %-18s %8.3f %8s %6.0f %6.0f %10.6f" % (
            mode, "AVG(%d)" % n,
            sum(r["wall"] for r in sel) / n,
            ("%.3f" % (sum(r["ttft"] for r in sel if r["ttft"]) / max(1, len([r for r in sel if r["ttft"]])))) if any(r["ttft"] for r in sel) else "-",
            sum(r["pt"] or 0 for r in sel) / n, sum(r["ct"] or 0 for r in sel) / n,
            sum(r["cost"] for r in sel) / n))
    print("=" * 100)
    nt = [r for r in rows if r["mode"] == "NT"]
    print("non-thinking JSON 解析成功率: %d/%d" % (sum(1 for r in nt if r["ok"]), len(nt)))
    print("正确率(A:%s B:%s C:%s D:%s E:%s F:%s)" % (TRUE_A, TRUE_B, TRUE_C, TRUE_D, TRUE_E, TRUE_F))
    for name in TRUTH:
        sel = [r for r in nt if r["case"] == name]
        if sel:
            print("  %-18s best=%s" % (name, [r["best"] for r in sel]))


if __name__ == "__main__":
    main()
