#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""测 deepseek-flash 视觉：编号框能否被当作 Jev 的"选项"来选；图片的 token/延迟/花费。"""
import base64, http.client, json, os, re, ssl, time

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = re.search(r"DEEPSEEK_API_KEY\s*:\s*(\S+)",
                open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()).group(1)

src = open(os.path.join(HERE, "jev控制台.html"), encoding="utf-8").read()
m = re.search(r"const DEFAULT_SYSTEM = \[(.*?)\]\.join\('\\n'\);", src, re.S)
SYS = "\n".join(re.findall(r"^'(.*)',?$", m.group(1), re.M))
SYS_V = SYS + ("\n\n图像规则:\n"
               "- 截图上用橙色方框标注了候选元素, 每个框左上角的标签(如 C1)就是它的选项名。\n"
               "- 只能从这些带标签的框里选, 不要自己发明坐标或新标签。\n"
               "- 先在心里把每个框对应的界面语义对上, 再作答。")

B64 = base64.b64encode(open(os.path.join(HERE, "desktop_mock.png"), "rb").read()).decode()

Q1 = """【情景】
这是当前桌面的完整截图。橙色框 = 可操作的候选元素, 框左上角标签就是选项名。
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 然后点击保存。

【问题】
id=q1, type=choice: 下一步应该先操作哪个候选元素?
【选项】 C1 / C2 / C3 / C4 / C5 / C6 / C7 / C8 / C9 / C10"""

Q4 = """【情景】
这是当前桌面的完整截图。橙色框 = 可操作的候选元素, 框左上角标签就是选项名。
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 然后点击保存。

【问题】(4 题彼此独立, 不得互相参照)
id=q1, type=choice: 下一步应该先操作哪个候选元素?  【选项】 C1 / C2 / C3 / C4 / C5 / C6 / C7 / C8 / C9 / C10
id=q2, type=noul:   此刻"保存"按钮处于可点击的启用状态吗?  【选项】 yes / no
id=q3, type=noul:   页面上是否存在红色错误提示?  【选项】 yes / no
id=q4, type=score:  红色错误提示条(C5)与"这次页面报错的原因"相关度(0~1)?  【选项】 score"""

TRUTH = {"q1": "C1", "q2": "no", "q3": "yes", "q4": "high"}


def call(user_blocks, label, detail=None):
    payload = {
        "model": "deepseek-flash",
        "messages": [{"role": "system", "content": SYS_V},
                     {"role": "user", "content": user_blocks}],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"}, "temperature": 0,
    }
    body = json.dumps(payload).encode()
    conn = http.client.HTTPSConnection("api.deepseek.com", timeout=180,
                                       context=ssl.create_default_context())
    t0 = time.perf_counter()
    conn.request("POST", "/v1/chat/completions", body=body,
                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    r = conn.getresponse(); d = json.loads(r.read()); conn.close()
    dt = (time.perf_counter() - t0) * 1000
    if "error" in d:
        print("[%s] API 错误: %s" % (label, json.dumps(d["error"], ensure_ascii=False))); return None
    u = d["usage"]; c = d["choices"][0]["message"]["content"]
    cost = (u.get("prompt_cache_miss_tokens", 0) / 1e6 * 0.15
            + u.get("prompt_cache_hit_tokens", 0) / 1e6 * 0.003
            + u.get("completion_tokens", 0) / 1e6 * 0.60)
    print("\n[%s] %6.0f ms  in=%d(hit %d/miss %d) out=%d  $%.6f  body=%.1f KB"
          % (label, dt, u["prompt_tokens"], u.get("prompt_cache_hit_tokens", 0),
             u.get("prompt_cache_miss_tokens", 0), u["completion_tokens"], cost,
             len(body) / 1024))
    try:
        j = json.loads(c)
        for a in j["answers"]:
            p = a["probs"]; s = sum(p.values()) or 1
            top = sorted(p.items(), key=lambda x: -x[1])[:4]
            print("    %-3s %-6s best=%-4s conf=%-5s  %s" % (
                a["id"], a["type"], a["best"], a["conf"],
                "  ".join("%s=%.0f%%" % (k, v / s * 100) for k, v in top)))
    except Exception as e:
        print("    解析失败:", e, c[:200])
    return u["prompt_tokens"], cost, dt


def img_block(detail):
    b = {"type": "image_url", "image_url": {"url": "data:image/png;base64," + B64}}
    if detail: b["image_url"]["detail"] = detail
    return b


print("=" * 84)
print("① 纯文本基线（无图）")
call([{"type": "text", "text": "id=q1, type=noul: 1+1=2 吗? 【选项】 yes / no"}], "无图基线")

print()
print("=" * 84)
print("② 图 + 单题（detail=original，默认）")
r1 = call([img_block(None), {"type": "text", "text": Q1}], "图+单题 original")

print()
print("=" * 84)
print("③ 图 + 单题（detail=low，降到 512x512）")
r2 = call([img_block("low"), {"type": "text", "text": Q1}], "图+单题 low")

print()
print("=" * 84)
print("④ 图 + 4 题一次调用（把图片成本摊到多题上）")
r4 = call([img_block(None), {"type": "text", "text": Q4}], "图+4题 original")

print()
print("=" * 84)
print("⑤ 图 + 4 题，detail=low")
r5 = call([img_block("low"), {"type": "text", "text": Q4}], "图+4题 low")
