#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""复刻 jev控制台.html 的请求组装，端到端验证页面可用。"""
import re, os, json, time, urllib.request

HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev控制台.html")
src = open(HTML, encoding="utf-8").read()

# --- 从 HTML 里抽出 DEFAULT_SYSTEM（页面实际会发出去的 system prompt） ---
m = re.search(r"const DEFAULT_SYSTEM = \[(.*?)\]\.join\('\\n'\);", src, re.S)
assert m, "找不到 DEFAULT_SYSTEM"
SYS = "\n".join(re.findall(r"^'(.*)',?$", m.group(1), re.M))
print("system prompt: %d 行 / %d 字符" % (len(SYS.split("\n")), len(SYS)))

# --- 抽出预设用例，确认标签解析数与页面一致 ---
presets = re.findall(r"\{ name: '([^']+)',\s*prompt: (\w+), options: ([^,]+), truth: '([^']*)' \}", src)
print("预设用例:")
for name, var, opt, truth in presets:
    print("   %-18s options=%-30s truth=%s" % (name, opt[:30], truth))

key = re.search(r"DEEPSEEK_API_KEY\s*:\s*(\S+)",
                open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()).group(1)

PROMPT_A = """【情景】
应用: 工单系统 工作项详情页
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 然后保存
可见可交互元素:
[E1] button "保存"      enabled=false
[E2] select "经办人"    value="张伟"
[E3] textbox "标题"     value="登录页报错"
[E4] button "取消"
[E5] link   "附件:log.txt"
已知: 未做任何修改时, "保存"按钮为禁用状态(enabled=false)。

【问题】
id=q1, type=choice: 下一步应该操作哪个元素?"""

PROMPT_F = """【情景】
应用: 内部审批系统 工单 #771
目标: 让该工单进入"已解决"状态
证据A: 工单状态="处理中", button "解决" enabled=true 且可见
证据B: 同一页面 tagged "待客户确认", 帮助文本: "待客户确认状态下请勿手动解决, 需等待客户回复"
证据C: 该工单已超期 11 天
可见元素: [X] button "解决"  [Y] link "等待客户确认"  [Z] button "升级给人工"

【问题】
id=q1, type=choice: 下一步应该做什么? (证据之间存在冲突, 请按真实把握程度作答)"""


def call(sys_text, user_text, label, origin="null"):
    body = {"model": "deepseek-flash",
            "messages": [{"role": "system", "content": sys_text},
                         {"role": "user", "content": user_text}],
            "response_format": {"type": "json_object"},
            "thinking": {"type": "disabled"}, "temperature": 0}
    req = urllib.request.Request(
        "https://api.deepseek.com/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key,
                 "Origin": origin})
    t0 = time.perf_counter()
    d = json.loads(urllib.request.urlopen(req, timeout=120).read())
    dt = (time.perf_counter() - t0) * 1000
    u = d["usage"]; c = d["choices"][0]["message"]["content"]
    cost = (u.get("prompt_cache_miss_tokens", 0) / 1e6 * 0.15
            + u.get("prompt_cache_hit_tokens", 0) / 1e6 * 0.003
            + u.get("completion_tokens", 0) / 1e6 * 0.60)
    jev = u["prompt_tokens"] / 1e6 * 0.042
    print("\n[%s] %.0fms  in=%d(hit %d/miss %d) out=%d  $%.6f  (Jev 同token $%.6f, %.2f×)"
          % (label, dt, u["prompt_tokens"], u.get("prompt_cache_hit_tokens", 0),
             u.get("prompt_cache_miss_tokens", 0), u["completion_tokens"], cost, jev,
             cost / jev if jev else 0))
    j = json.loads(c)
    for a in j["answers"]:
        p = a["probs"]; s = sum(p.values())
        norm = {k: round(v / s, 4) for k, v in p.items()}
        norm = dict(sorted(norm.items(), key=lambda x: -x[1]))
        print("   %s %-6s best=%-4s conf=%-5s 原始合计=%.3f" % (a["id"], a["type"], a["best"], a["conf"], s))
        print("   页面会画的条: " + "  ".join("%s=%.1f%%" % (k, v * 100) for k, v in list(norm.items())[:6]))
    return c


print("\n" + "=" * 78)
print("模拟页面发送（Origin: null，等同双击 file:// 打开）")
print("=" * 78)
call(SYS, PROMPT_A + "\n【选项】 E1 / E2 / E3 / E4 / E5", "A 页面原样")
call(SYS, PROMPT_A + "\n【选项】 E1 / E2 / E3 / E4 / E5", "A 再发一次(验缓存)")
call(SYS, PROMPT_F + "\n【选项】 X / Y / Z", "F 证据冲突")
