#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
jev_probe2 —— 把第一个探针的结论钉死:
  1) DeepSeek 的"地板延迟"(固定开销), 用来判断 70~500ms 是否有戏
  2) 1500 token 级真实桌面状态: 单题 / 一次多题 / 同状态重复问 -> 缓存与花费
  3) 状态前缀缓存实测 (Jev 的并行采样器卖点, 在 chat API 上等价物是什么)
"""
import json, os, re, time, urllib.request, urllib.error, statistics
import importlib.util

spec = importlib.util.spec_from_file_location(
    "jp", os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev_probe.py"))
jp = importlib.util.module_from_spec(spec); spec.loader.exec_module(jp)
KEY, JEV_SYSTEM, cost = jp.KEY, jp.JEV_SYSTEM, jp.cost

API = jp.API
def call(msgs, thinking=False, timeout=180, max_tokens=None):
    body = {"model": "deepseek-flash", "messages": msgs,
            "response_format": {"type": "json_object"}}
    body["thinking"] = {"type": "enabled"} if thinking else {"type": "disabled"}
    if not thinking: body["temperature"] = 0.0
    if max_tokens: body["max_tokens"] = max_tokens
    req = urllib.request.Request(API, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        d = json.loads(r.read())
    return time.perf_counter() - t0, d

# ---------------- 1) 地板延迟 ----------------
print("=" * 96)
print("① 地板延迟 (无关内容量, 纯网络+排队+调度开销)")
lat = []
for i in range(6):
    dt, d = call([{"role": "user", "content": 'Return JSON: {"ok":1}'}], max_tokens=16)
    lat.append(dt)
    print("   #%d  %.3fs   in=%d out=%d" % (i, dt, d["usage"]["prompt_tokens"], d["usage"]["completion_tokens"]))
print("   min=%.3fs  median=%.3fs  max=%.3fs" % (min(lat), statistics.median(lat), max(lat)))
FLOOR = min(lat)

# ---------------- 2) 1500 token 级真实状态 ----------------
# 造一个工单详情页: 长评论历史 + 一堆可交互元素
history = "\n".join(
    "  [%02d] %s | %s | %s" % (i, "张伟" if i % 3 else "李娜", "2026-09-%02d %02d:%02d" % (i % 28 + 1, i % 24, i * 7 % 60),
                              "已定位到登录接口在 token 过期后未刷新, 复现步骤: 1. 打开登录页 2. 等待 30 分钟 3. 点击提交. 日志片段: "
                              "WARN auth.TokenStore - refresh skipped, exp=1758%04d; ERROR login.Controller - NPE at line %d" % (i * 13, i * 3))
    for i in range(1, 21))
els = "\n".join("[E%02d] %s" % (i, t) for i, t in enumerate([
    'button "保存"  enabled=false', 'select "经办人" value="张伟"', 'textbox "标题" value="登录页报错"',
    'button "取消"', 'link "附件:server.log"', 'tab "评论"', 'tab "附件"', 'tab "历史"',
    'button "添加评论"', 'textbox "搜索"', 'button "关注"', 'button "更多操作"',
    'div "状态: 处理中"', 'div "优先级: 高"', 'div "逾期: 11 天"', 'link "关联工作项 #1039"',
    'button "复制链接"', 'button "打印"', 'button "导出"', 'button "刷新"'], 1))
STATE = """【情景】
应用: 工单系统 工作项详情页 (http://ticket.local/workitem/1042)  —— 这是本次决策的全部事实来源
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 并保存成功
页面可见元素(已过滤为可交互项):
%s

评论历史(按时间正序):
%s

已知事实:
  - 未做任何修改时 "保存" 按钮为禁用状态(enabled=false)
  - "经办人" 字段只有点击后才会展开下拉列表, 展开后可见选项: 张伟 / 李娜 / 王芳
  - 当前登录账号是 张伟 本人
""" % (els, history)

Q6 = """
【问题】(6 题彼此独立, 不得互相参照、互相影响)
id=q1, type=choice: 下一步应该操作哪个元素?   【选项】 %s
id=q2, type=noul:   此刻立刻点"保存"能保存成功吗?   【选项】 yes / no
id=q3, type=noul:   "经办人"字段当前是否已经展开?   【选项】 yes / no
id=q4, type=choice: 评论历史里出现的报错, 属于前端还是后端?   【选项】 前端 / 后端 / 无法判断
id=q5, type=score:  评论历史中 "token 过期后未刷新" 这条线索与"登录页报错"的相关度(0~1)?  【选项】 score
id=q6, type=choice: 该工单的逾期天数是多少?   【选项】 0 / 11 / 30 / 无法判断
""" % " / ".join("E%02d" % i for i in range(1, 21))

print("\n" + "=" * 96)
print("② 真实规模 (~1500 token 状态)")

runs = {}
# (a) 一次多题 (Jev parallel sampler 的等价物)
dt, d = call([{"role": "system", "content": JEV_SYSTEM},
              {"role": "user", "content": STATE + Q6}])
u = d["usage"]
print("   (a) 同状态+6题 一次调用 : %.3fs  in=%d(hit %d/miss %d) out=%d  $%.6f"
      % (dt, u["prompt_tokens"], u.get("prompt_cache_hit_tokens", 0), u.get("prompt_cache_miss_tokens", 0),
         u["completion_tokens"], cost(u)))
print("       raw:", d["choices"][0]["message"]["content"][:1200])
runs["one_call_6q"] = (dt, u)

# (b) 同状态拆成 6 次独立调用 —— 测前缀缓存
print("   (b) 同状态拆 6 次独立调用 (每题一次):")
tot_dt, tot, hits = 0.0, 0.0, []
qlines = Q6.strip().split("\n")
for k in range(6):
    q = "【问题】(单题)\n" + qlines[k + 1]
    dt, d = call([{"role": "system", "content": JEV_SYSTEM},
                  {"role": "user", "content": STATE + "\n" + q}])
    u = d["usage"]; c = cost(u); tot_dt += dt; tot += c; hits.append(u.get("prompt_cache_hit_tokens", 0))
    print("        q%d %.3fs in=%d(hit %d) out=%d $%.6f" % (k + 1, dt, u["prompt_tokens"],
          u.get("prompt_cache_hit_tokens", 0), u["completion_tokens"], c))
print("        6 次合计 %.3fs  $%.6f   (缓存命中 %s)" % (tot_dt, tot, hits))

# (c) 真正冷状态(加 nonce 破坏前缀) 单题 —— 控制组
nonce = "冷启动-%d" % int(time.time())
STATE_COLD = STATE.replace("workitem/1042)", "workitem/1042#%s)" % nonce, 1)
assert STATE_COLD != STATE, "nonce 未生效"
dt, d = call([{"role": "system", "content": JEV_SYSTEM},
              {"role": "user", "content": STATE_COLD + "\n【问题】(单题)\n" +
               "id=q1, type=choice: 下一步应该操作哪个元素?  【选项】 " +
               " / ".join("E%02d" % i for i in range(1, 21))}])
u = d["usage"]
print("   (c) 冷状态 单题          : %.3fs  in=%d(hit %d/miss %d) out=%d  $%.6f"
      % (dt, u["prompt_tokens"], u.get("prompt_cache_hit_tokens", 0), u.get("prompt_cache_miss_tokens", 0),
         u["completion_tokens"], cost(u)))
cold = (dt, u)

# ---------------- 3) 外推 ----------------
print("\n" + "=" * 96)
print("③ 花费外推 (off-peak 单价; Jev = $%.3f/M input, 输出免费)" % jp.JEV_P_IN)
pt, ct = u["prompt_tokens"], u["completion_tokens"]
for label, per_call in [
    ("DeepSeek 冷状态 (cache miss)", pt / 1e6 * jp.P_IN_MISS + ct / 1e6 * jp.P_OUT),
    ("DeepSeek 热状态 (cache hit) ", pt / 1e6 * jp.P_IN_HIT + ct / 1e6 * jp.P_OUT),
    ("Jev (同 token 量)           ", pt / 1e6 * jp.JEV_P_IN),
]:
    print("   %s : $%.6f/次  ->  $%.2f / 10万次" % (label, per_call, per_call * 1e5))

json.dump({"floor_s": FLOOR, "floor_all": lat, "cold_in": pt, "cold_out": ct},
          open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "jev_probe2_result.json"), "w"),
          ensure_ascii=False, indent=1)
print("\n地板延迟 = %.3fs  (这是 DeepSeek 任何一次调用都绕不开的下限)" % FLOOR)
print("Jev 宣称 70~500ms -> DeepSeek 地板已是它的 %.1f~%.1f 倍" % (FLOOR / 0.5, FLOOR / 0.07))
