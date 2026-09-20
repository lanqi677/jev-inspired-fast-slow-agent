#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合成一张仿真桌面截图（带编号候选框），用于测 deepseek-flash 的视觉决策能力与图片 token 成本。"""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1440, 900
FONT = "/usr/share/fonts/opentype/source-han-cjk/SourceHanSansSC-Regular.otf"
FONTB = "/usr/share/fonts/opentype/source-han-cjk/SourceHanSansSC-Medium.otf"
f = lambda s: ImageFont.truetype(FONT, s)
fb = lambda s: ImageFont.truetype(FONTB, s)

img = Image.new("RGB", (W, H), "#f5f6f8")
d = ImageDraw.Draw(img)

# ---- 顶栏 ----
d.rectangle([0, 0, W, 48], fill="#2b3a55")
d.text((18, 14), "工单系统 工作项详情", font=fb(17), fill="#ffffff")
d.text((W - 300, 16), "张伟  |  通知  |  帮助", font=f(13), fill="#c8d3e6")

# ---- 左侧栏 ----
d.rectangle([0, 48, 190, H], fill="#eef1f5")
for i, t in enumerate(["我的工作台", "工作项", "迭代", "测试", "报表", "设置"]):
    d.text((18, 70 + i * 32), t, font=f(14), fill="#3a4356" if i != 1 else "#2f6df6")

# ---- 主区域 ----
x0 = 214
d.text((x0, 66), "登录页报错 #1042", font=fb(21), fill="#1b1e23")
d.text((x0 + 250, 74), "处理中", font=f(13), fill="#c47f00")

# 字段行
d.rectangle([x0, 108, W - 20, 250], fill="#ffffff", outline="#e2e4e9")
rows = [("经办人", "张伟"), ("优先级", "高"), ("逾期", "11 天"), ("标题", "登录页报错")]
for i, (k, v) in enumerate(rows):
    y = 122 + i * 32
    d.text((x0 + 16, y), k, font=f(13), fill="#61676f")
    if k == "经办人":
        # 下拉框（带边框 -> 候选元素）
        d.rectangle([x0 + 90, y - 5, x0 + 300, y + 22], fill="#ffffff", outline="#c8ccd4")
        d.text((x0 + 100, y), v, font=f(13), fill="#1b1e23")
        d.polygon([(x0 + 278, y + 6), (x0 + 292, y + 6), (x0 + 285, y + 13)], fill="#61676f")
    else:
        d.text((x0 + 100, y), v, font=f(13), fill="#1b1e23")

# ---- 错误提示条（红色）----
d.rectangle([x0, 266, W - 20, 306], fill="#fdecea", outline="#f3b6b0")
d.text((x0 + 14, 276), "错误: Uncaught TypeError: Cannot read property 'id' of undefined  (login.Controller:118)",
       font=f(13), fill="#d92d20")

# ---- Tab ----
for i, t in enumerate(["评论", "附件", "历史", "关联"]):
    tx = x0 + i * 88
    d.text((tx, 326), t, font=f(14), fill="#2f6df6" if i == 0 else "#61676f")
    if i == 0:
        d.line([tx, 348, tx + 28, 348], fill="#2f6df6", width=2)

# ---- 评论列表 ----
comments = [
    ("李娜", "已定位到登录接口在 token 过期后未刷新", "09-18 14:22"),
    ("王芳", "复现步骤: 打开登录页 -> 等待 30 分钟 -> 点击提交", "09-18 16:05"),
    ("张伟", "日志: WARN auth.TokenStore - refresh skipped, exp=1758", "09-19 09:11"),
]
for i, (who, txt, t) in enumerate(comments):
    y = 366 + i * 62
    d.rectangle([x0, y, W - 20, y + 52], fill="#ffffff", outline="#e2e4e9")
    d.text((x0 + 14, y + 8), who, font=fb(13), fill="#2b3a55")
    d.text((x0 + 74, y + 8), t, font=f(12), fill="#9aa1ab")
    d.text((x0 + 14, y + 28), txt, font=f(13), fill="#1b1e23")

# ---- 底部按钮行 ----
by = 578
btns = [("添加评论", 96), ("关注", 62), ("复制链接", 82), ("打印", 62), ("导出", 62), ("更多操作", 86)]
bx = x0
boxes = []
for name, w in btns:
    d.rectangle([bx, by, bx + w, by + 32], fill="#ffffff", outline="#c8ccd4")
    d.text((bx + 12, by + 8), name, font=f(13), fill="#2b3a55")
    boxes.append((name, bx, by, bx + w, by + 32))
    bx += w + 12

# 保存 / 取消（右侧）
d.rectangle([W - 210, by, W - 120, by + 32], fill="#e9edf4", outline="#c8ccd4")
d.text((W - 196, by + 8), "取消", font=f(13), fill="#61676f")
d.rectangle([W - 108, by, W - 20, by + 32], fill="#c8ccd4", outline="#c8ccd4")
d.text((W - 90, by + 8), "保存", font=f(13), fill="#ffffff")

# ================= 叠加编号候选框 =================
# (编号, x1,y1,x2,y2, 说明)  —— 这些框就是要喂给模型的"选项"
CAND = [
    ("C1", x0 + 88, 115, x0 + 302, 172, "经办人下拉框"),
    ("C2", W - 108, by - 4, W - 18, by + 36, "保存按钮(灰色/禁用)"),
    ("C3", W - 210, by - 4, W - 118, by + 36, "取消按钮"),
    ("C4", x0 + 0, by - 4, x0 + 100, by + 36, "添加评论按钮"),
    ("C5", x0 - 2, 262, W - 18, 310, "红色报错提示条"),
    ("C6", x0 + 176, 320, x0 + 266, 350, "附件 Tab"),
    ("C7", x0 + 0, 320, x0 + 90, 350, "评论 Tab"),
    ("C8", x0 - 2, 362, W - 18, 424, "第 1 条评论"),
    ("C9", x0 - 2, 486, W - 18, 548, "第 3 条评论(日志)"),
    ("C10", 0, 96, 190, 128, "左侧'工作项'菜单"),
]

for cid, x1, y1, x2, y2, _ in CAND:
    d.rectangle([x1, y1, x2, y2], outline="#ff6a00", width=2)
    tag = cid
    tw = d.textlength(tag, font=fb(12))
    d.rectangle([x1, y1 - 17, x1 + tw + 10, y1 - 1], fill="#ff6a00")
    d.text((x1 + 5, y1 - 16), tag, font=fb(12), fill="#ffffff")

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "desktop_mock.png")
img.save(out)
print("saved:", out, img.size, "| 候选框:", len(CAND))
for c in CAND:
    print("   ", c[0], c[5])
