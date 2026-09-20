#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""核对延迟口径：每次新建连接 vs 连接复用（浏览器/页面的真实行为）。"""
import http.client, json, os, re, ssl, statistics, time

KEY = re.search(r"DEEPSEEK_API_KEY\s*:\s*(\S+)",
                open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()).group(1)
SYS = "你是 System One。只输出 JSON。"
USR = "id=q1, type=choice: 下一步点哪个? 【选项】 E1 / E2 / E3 / E4 / E5"

PAYLOAD = json.dumps({
    "model": "deepseek-flash",
    "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": USR}],
    "response_format": {"type": "json_object"},
    "thinking": {"type": "disabled"}, "temperature": 0,
}).encode()
HDR = {"Content-Type": "application/json", "Authorization": "Bearer " + KEY}


def one(conn):
    t0 = time.perf_counter()
    conn.request("POST", "/v1/chat/completions", body=PAYLOAD, headers=HDR)
    r = conn.getresponse()
    d = json.loads(r.read())
    return (time.perf_counter() - t0) * 1000, d["usage"]


print("=" * 78)
print("① 连接复用（一个 HTTPSConnection 连打 6 次 —— 等价于浏览器 keep-alive）")
conn = http.client.HTTPSConnection("api.deepseek.com", timeout=120, context=ssl.create_default_context())
reuse = []
for i in range(6):
    dt, u = one(conn)
    reuse.append(dt)
    print("   #%d  %6.0f ms   in=%d out=%d" % (i + 1, dt, u["prompt_tokens"], u["completion_tokens"]))
conn.close()
print("   min=%.0f  median=%.0f  max=%.0f ms" % (min(reuse), statistics.median(reuse), max(reuse)))

print()
print("=" * 78)
print("② 每次新建连接（我早先的口径 —— 混入了 TCP+TLS 握手）")
fresh = []
for i in range(6):
    c = http.client.HTTPSConnection("api.deepseek.com", timeout=120, context=ssl.create_default_context())
    dt, u = one(c)
    c.close()
    fresh.append(dt)
    print("   #%d  %6.0f ms" % (i + 1, dt))
print("   min=%.0f  median=%.0f  max=%.0f ms" % (min(fresh), statistics.median(fresh), max(fresh)))

print()
print("=" * 78)
handshake = statistics.median(fresh) - statistics.median(reuse)
print("结论:")
print("  连接复用中位 %.0f ms   新建连接中位 %.0f ms   握手成本 ≈ %.0f ms"
      % (statistics.median(reuse), statistics.median(fresh), handshake))
print("  复用后落在 Jev 宣称 70~500ms 区间内: %s"
      % ("是" if max(reuse) <= 500 else "否 (max %.0fms)" % max(reuse)))
