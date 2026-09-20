#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""高分辨率测：2560x1600 全屏截图下，小号编号标签会不会被缩放糊掉；放大标签能否救回来。"""
import base64, http.client, json, os, re, ssl, sys, time
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = "/usr/share/fonts/opentype/source-han-cjk/SourceHanSansSC-Regular.otf"
FONTB = "/usr/share/fonts/opentype/source-han-cjk/SourceHanSansSC-Medium.otf"


def render(W, H, label_px, out):
    """同一套 UI 布局，画在 W x H 画布上；label_px 控制橙框标签字号。"""
    f = lambda s: ImageFont.truetype(FONT, s)
    fb = lambda s: ImageFont.truetype(FONTB, s)
    img = Image.new("RGB", (W, H), "#f5f6f8")
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 48], fill="#2b3a55")
    d.text((18, 14), "工单系统 工作项详情", font=fb(17), fill="#ffffff")
    d.rectangle([0, 48, 190, H], fill="#eef1f5")
    for i, t in enumerate(["我的工作台", "工作项", "迭代", "测试", "报表", "设置"]):
        d.text((18, 70 + i * 32), t, font=f(14), fill="#3a4356")
    x0 = 214
    d.text((x0, 66), "登录页报错 #1042", font=fb(21), fill="#1b1e23")
    d.rectangle([x0, 108, W - 20, 250], fill="#ffffff", outline="#e2e4e9")
    for i, (k, v) in enumerate([("经办人", "张伟"), ("优先级", "高"), ("逾期", "11 天"), ("标题", "登录页报错")]):
        y = 122 + i * 32
        d.text((x0 + 16, y), k, font=f(13), fill="#61676f")
        if k == "经办人":
            d.rectangle([x0 + 90, y - 5, x0 + 300, y + 22], fill="#ffffff", outline="#c8ccd4")
            d.text((x0 + 100, y), v, font=f(13), fill="#1b1e23")
            d.polygon([(x0 + 278, y + 6), (x0 + 292, y + 6), (x0 + 285, y + 13)], fill="#61676f")
        else:
            d.text((x0 + 100, y), v, font=f(13), fill="#1b1e23")
    d.rectangle([x0, 266, W - 20, 306], fill="#fdecea", outline="#f3b6b0")
    d.text((x0 + 14, 276), "错误: Uncaught TypeError: Cannot read property 'id' of undefined  (login.Controller:118)",
           font=f(13), fill="#d92d20")
    for i, t in enumerate(["评论", "附件", "历史", "关联"]):
        d.text((x0 + i * 88, 326), t, font=f(14), fill="#2f6df6" if i == 0 else "#61676f")
    for i, (who, txt, t) in enumerate([
            ("李娜", "已定位到登录接口在 token 过期后未刷新", "09-18 14:22"),
            ("王芳", "复现步骤: 打开登录页 -> 等待 30 分钟 -> 点击提交", "09-18 16:05"),
            ("张伟", "日志: WARN auth.TokenStore - refresh skipped, exp=1758", "09-19 09:11")]):
        y = 366 + i * 62
        d.rectangle([x0, y, W - 20, y + 52], fill="#ffffff", outline="#e2e4e9")
        d.text((x0 + 14, y + 8), who, font=fb(13), fill="#2b3a55")
        d.text((x0 + 74, y + 8), t, font=f(12), fill="#9aa1ab")
        d.text((x0 + 14, y + 28), txt, font=f(13), fill="#1b1e23")
    by = 578
    btns = [("添加评论", 96), ("关注", 62), ("复制链接", 82), ("打印", 62), ("导出", 62), ("更多操作", 86)]
    bx = x0
    for name, w in btns:
        d.rectangle([bx, by, bx + w, by + 32], fill="#ffffff", outline="#c8ccd4")
        d.text((bx + 12, by + 8), name, font=f(13), fill="#2b3a55")
        bx += w + 12
    d.rectangle([W - 210, by, W - 120, by + 32], fill="#e9edf4", outline="#c8ccd4")
    d.text((W - 196, by + 8), "取消", font=f(13), fill="#61676f")
    d.rectangle([W - 108, by, W - 20, by + 32], fill="#c8ccd4", outline="#c8ccd4")
    d.text((W - 90, by + 8), "保存", font=f(13), fill="#ffffff")

    CAND = [("C1", x0 + 88, 115, x0 + 302, 172), ("C2", W - 108, by - 4, W - 18, by + 36),
            ("C3", W - 210, by - 4, W - 118, by + 36), ("C4", x0, by - 4, x0 + 100, by + 36),
            ("C5", x0 - 2, 262, W - 18, 310), ("C6", x0 + 176, 320, x0 + 266, 350),
            ("C7", x0, 320, x0 + 90, 350), ("C8", x0 - 2, 362, W - 18, 424),
            ("C9", x0 - 2, 486, W - 18, 548), ("C10", 0, 96, 190, 128)]
    for cid, x1, y1, x2, y2 in CAND:
        d.rectangle([x1, y1, x2, y2], outline="#ff6a00", width=max(2, label_px // 8))
        tw = d.textlength(cid, font=fb(label_px))
        d.rectangle([x1, y1 - label_px - 5, x1 + tw + 12, y1 - 1], fill="#ff6a00")
        d.text((x1 + 6, y1 - label_px - 4), cid, font=fb(label_px), fill="#ffffff")
    img.save(out)
    return out


KEY = re.search(r"DEEPSEEK_API_KEY\s*:\s*(\S+)",
                open(os.path.expanduser("~/.dsh/.credentials.yaml"), encoding="utf-8").read()).group(1)
src = open(os.path.join(HERE, "jev控制台.html"), encoding="utf-8").read()
m = re.search(r"const DEFAULT_SYSTEM = \[(.*?)\]\.join\('\\n'\);", src, re.S)
SYS = "\n".join(re.findall(r"^'(.*)',?$", m.group(1), re.M))
SYS += ("\n\n图像规则:\n- 截图上用橙色方框标注了候选元素, 每个框左上角的标签(如 C1)就是它的选项名。\n"
        "- 只能从这些带标签的框里选, 不要自己发明坐标或新标签。")

Q1 = """【情景】
这是当前桌面的完整截图。橙色框 = 可操作的候选元素, 框左上角标签就是选项名。
目标: 把该工作项的"经办人"从 张伟 改成 李娜, 然后点击保存。

【问题】
id=q1, type=choice: 下一步应该先操作哪个候选元素?
【选项】 C1 / C2 / C3 / C4 / C5 / C6 / C7 / C8 / C9 / C10"""


def run(png, label):
    b64 = base64.b64encode(open(png, "rb").read()).decode()
    payload = {"model": "deepseek-flash",
               "messages": [{"role": "system", "content": SYS},
                            {"role": "user", "content": [
                                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + b64}},
                                {"type": "text", "text": Q1}]}],
               "response_format": {"type": "json_object"},
               "thinking": {"type": "disabled"}, "temperature": 0}
    conn = http.client.HTTPSConnection("api.deepseek.com", timeout=180, context=ssl.create_default_context())
    t0 = time.perf_counter()
    conn.request("POST", "/v1/chat/completions", body=json.dumps(payload).encode(),
                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    d = json.loads(conn.getresponse().read()); conn.close()
    dt = (time.perf_counter() - t0) * 1000
    u = d["usage"]; a = json.loads(d["choices"][0]["message"]["content"])["answers"][0]
    p = a["probs"]; s = sum(p.values()) or 1
    top = sorted(p.items(), key=lambda x: -x[1])[:3]
    ok = "✅" if a["best"] == "C1" else "❌"
    print("  %-26s %5.0fms in=%-5d out=%-4d $%.6f  %s best=%-4s conf=%-5s %s"
          % (label, dt, u["prompt_tokens"], u["completion_tokens"],
             u.get("prompt_cache_miss_tokens", 0) / 1e6 * 0.15 + u.get("completion_tokens", 0) / 1e6 * 0.60,
             ok, a["best"], a["conf"], " ".join("%s=%.0f%%" % (k, v / s * 100) for k, v in top)))
    return a["best"] == "C1"


H = Image.open(os.path.join(HERE, "desktop_mock.png")).height
print("真实屏幕分辨率下的可读性（正确目标永远是 C1）")
print("=" * 96)
print("基准 1440x900（不缩放）:")
run(os.path.join(HERE, "desktop_mock.png"), "1440x900 · 标签 12px")

print("\nLegion R7000 全屏 2560x1600（会被缩到约 1300x1300 等效）:")
p1 = render(2560, 1600, 12, os.path.join(HERE, "mock_2560_small.png"))
run(p1, "2560x1600 · 标签 12px")
p2 = render(2560, 1600, 22, os.path.join(HERE, "mock_2560_big.png"))
run(p2, "2560x1600 · 标签 22px")

print("\n只截取内容区 1440x900 后再发（不缩放）:")
p3 = Image.open(p1).crop((0, 0, 1440, 900))
p3.save(os.path.join(HERE, "mock_2560_crop.png"))
run(os.path.join(HERE, "mock_2560_crop.png"), "2560 屏 · 裁到 1440x900")
