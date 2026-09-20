#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jev_probe3 —— 关键的两个"效果"问题:
  A) 证据阶梯: 同一情景, 只增删一条"消歧事实", 看置信度会不会跟着动
     -> 置信度若跟着证据动 = 可用于阈值分流; 若永远 0.95 = Jev 卖的那点东西没拿到
  B) 选项规模: N=60 时还能不能给出覆盖全部选项的分布(Jev 上限 255)
  C) 网络 RTT 拆解: 地板延迟里有多少是网线, 多少是模型
"""
import json, os, re, statistics, time, urllib.request, urllib.error, importlib.util

spec = importlib.util.spec_from_file_location(
    "jp", os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev_probe.py"))
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
KEY, JEV_SYSTEM, cost, call0 = jp.KEY, jp.JEV_SYSTEM, jp.cost, jp.call

def call(msgs, timeout=180):
    return call0(msgs, thinking=False, timeout=timeout)

# ---------------- C) 网络 RTT ----------------
print("=" * 96)
print("③ 网络 RTT (curl /v1/models, 不含任何模型推理)")
rtt = []
for i in range(5):
    t0 = time.perf_counter()
    req = urllib.request.Request("https://api.deepseek.com/v1/models",
                                 headers={"Authorization": "Bearer " + KEY})
    urllib.request.urlopen(req, timeout=20).read()
    rtt.append(time.perf_counter() - t0)
print("   min=%.3fs median=%.3fs max=%.3fs" % (min(rtt), statistics.median(rtt), max(rtt)))
RTT = min(rtt)

# ---------------- A) 证据阶梯 ----------------
BASE = """【情景】
应用: 内部运维后台 —— 服务器列表页
目标: 重启 10.0.3.7 这台机器的服务
可见可交互元素:
[E1] button "刷新列表"
[E2] button "重启服务"        (该按钮作用于【当前选中行】)
[E3] div    "10.0.3.7  运行中"
[E4] div    "10.0.3.9  运行中"
[E5] textbox "搜索"
[E6] button "导出报表"
%s
【问题】
id=q1, type=choice: 下一步应该操作哪个元素?
【选项】 E1 / E2 / E3 / E4 / E5 / E6"""

FACT_SELECTED = '[E7] div    "当前选中行: 10.0.3.7"'
FACT_UNSELECTED = '[E7] div    "当前选中行: 10.0.3.9"'
FACT_NONE = ''

VARIANTS = [
    ("强证据(选中就是目标)", FACT_SELECTED),
    ("反证据(选中是另一台)", FACT_UNSELECTED),
    ("无消歧事实(悬空)", FACT_NONE),
]
print("\n" + "=" * 96)
print("① 证据阶梯 —— 只改一条事实, 看置信度是否跟着动")
print("   期望: 强证据 -> 高置信; 反证据/悬空 -> 低置信, 且应触发升级给人")
ladder = {}
for label, fact in VARIANTS:
    for rep in range(2):
        msgs = [{"role": "system", "content": JEV_SYSTEM},
                {"role": "user", "content": BASE % fact}]
        r = call(msgs); u = r["resp"]["usage"]
        txt = r["resp"]["choices"][0]["message"]["content"]
        j = json.loads(txt); a = j["answers"][0]
        p = a["probs"]
        print("   %-22s rep%d  best=%-3s conf=%.2f  P(E2)=%.2f P(E3)=%.2f | %.2fs $%.6f"
              % (label, rep, a.get("best"), a.get("conf", 0), p.get("E2", 0), p.get("E3", 0),
                 r["wall"], cost(u)))
        ladder.setdefault(label, []).append((a.get("best"), a.get("conf"), p.get("E2")))

print("\n   -> 强/弱置信差 = %.2f" % (
    statistics.mean(c for _, c, _ in ladder["强证据(选中就是目标)"])
    - statistics.mean(c for _, c, _ in ladder["无消歧事实(悬空)"])))

# ---------------- B) N=60 选项 ----------------
print("\n" + "=" * 96)
print("② 选项规模 —— Jev 上限 255; 测 N=60 是否还能全覆盖")
for N in (20, 60):
    items = []
    for i in range(1, N + 1):
        items.append("[O%02d] %s" % (i, 'div "普通字段 %d"' % i))
    # 埋一个明确的目标
    tgt = 42 if N >= 42 else N
    items[tgt - 1] = '[O%02d] div "错误码 500: 数据库连接池耗尽 (红色)"' % tgt
    prompt = """【情景】
应用: 系统监控大盘
目标: 找出当前最严重的告警项
可见可交互元素:
%s
【问题】
id=q1, type=choice: 最严重的告警是哪个?
【选项】 %s""" % ("\n".join(items), " / ".join("O%02d" % i for i in range(1, N + 1)))
    r = call([{"role": "system", "content": JEV_SYSTEM}, {"role": "user", "content": prompt}])
    u = r["resp"]["usage"]; txt = r["resp"]["choices"][0]["message"]["content"]
    try:
        a = json.loads(txt)["answers"][0]; p = a["probs"]
        ncov = len(p); s = sum(float(v) for v in p.values())
        print("   N=%-3d  wall=%.3fs in=%d out=%d $%.6f  覆盖 %d/%d 选项  prob_sum=%.2f  best=%s(%.2f) %s"
              % (N, r["wall"], u["prompt_tokens"], u["completion_tokens"], cost(u), ncov, N, s,
                 a.get("best"), a.get("conf", 0), "OK" if a.get("best") == "O%02d" % tgt else "!! 错"))
    except Exception as e:
        print("   N=%-3d  wall=%.3fs 解析失败 %s  raw=%s" % (N, r["wall"], e, txt[:200]))

print("\n地板延迟拆解: RTT %.3fs + 模型侧 %.3fs = %.3fs(实测 min)" % (RTT, 0.611 - RTT, 0.611))
print("Jev 宣称 70~500ms; 仅网络往返就 %.0f~%.0fms" % (RTT * 1000, RTT * 1000))
