#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""用页面完全相同的请求（663 字符 system prompt + 预设 A），连打 15 次，看延迟分布。"""
import http.client, json, os, re, ssl, statistics, time

KEY = re.search(r"DEEPSEEK_API_KEY\s*:\s*(\S+)",
                open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()).group(1)

HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev控制台.html")
src = open(HTML, encoding="utf-8").read()
m = re.search(r"const DEFAULT_SYSTEM = \[(.*?)\]\.join\('\\n'\);", src, re.S)
SYS = "\n".join(re.findall(r"^'(.*)',?$", m.group(1), re.M))

USR = """【情景】
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
id=q1, type=choice: 下一步应该操作哪个元素?
【选项】 E1 / E2 / E3 / E4 / E5"""

PAYLOAD = json.dumps({
    "model": "deepseek-flash",
    "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": USR}],
    "response_format": {"type": "json_object"},
    "thinking": {"type": "disabled"}, "temperature": 0,
}).encode()
HDR = {"Content-Type": "application/json", "Authorization": "Bearer " + KEY}

conn = http.client.HTTPSConnection("api.deepseek.com", timeout=120, context=ssl.create_default_context())
lat, pin, pout, hits = [], [], [], []
print("15 次连打（完全等于页面发出的请求）:")
for i in range(15):
    t0 = time.perf_counter()
    conn.request("POST", "/v1/chat/completions", body=PAYLOAD, headers=HDR)
    r = conn.getresponse(); d = json.loads(r.read())
    dt = (time.perf_counter() - t0) * 1000
    u = d["usage"]
    best = json.loads(d["choices"][0]["message"]["content"])["answers"][0]["best"]
    lat.append(dt); pin.append(u["prompt_tokens"]); pout.append(u["completion_tokens"])
    hits.append(u.get("prompt_cache_hit_tokens", 0))
    print("   #%-2d %6.0f ms  in=%d(hit %d) out=%d  best=%s" % (i + 1, dt, u["prompt_tokens"],
          u.get("prompt_cache_hit_tokens", 0), u["completion_tokens"], best))
conn.close()

lat_s = sorted(lat)
def pct(p): return lat_s[min(len(lat_s) - 1, int(len(lat_s) * p))]
print()
print("分布: min=%.0f  p25=%.0f  p50=%.0f  p75=%.0f  max=%.0f ms"
      % (lat_s[0], pct(.25), statistics.median(lat), pct(.75), lat_s[-1]))
print("落进 Jev 70~500ms 的: %d/15   超过 500ms 的: %d/15"
      % (sum(1 for x in lat if x <= 500), sum(1 for x in lat if x > 500)))
print("in=%d  out=%d  缓存命中后段=%d" % (pin[0], pout[0], hits[-1]))
