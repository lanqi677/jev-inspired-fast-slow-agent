"""Jev 风格本地决策引擎实测（llama.cpp / GGUF，纯 CPU）
任务形态完全对齐 Jev：固定选项选择 / 打分 / yes-no，并强制约束解码只输出标签。
指标：TTFT(提示处理)、decode 速度、端到端决策延迟。
"""
import os, sys, time, glob, json

MODELS = sorted(glob.glob('models/*.gguf'))

# --- Jev 风格任务：一次给出 3 个独立判断 ---
SYS = ("你是一个决策引擎。只允许输出 JSON，不要解释。")
EMAIL = ("客户邮件：我上周三下单买的蓝牙耳机，今天收到发现左耳没有声音，包装盒也被压瘪了。"
         "我已经联系过客服两次都没人回复，非常生气。请判断：")
PROMPT_TMPL = """{sys}
判断下面三个问题，输出 JSON：{{"dept":"售后|物流|财务|技术|投诉","risk":"low|medium|high","human":0或1}}
{email}"""

GRAMMAR = r'''
root ::= "{" ws "\"dept\"" ws ":" ws dept ws "," ws "\"risk\"" ws ":" ws risk ws "," ws "\"human\"" ws ":" ws human ws "}"
dept ::= "\"售后\"" | "\"物流\"" | "\"财务\"" | "\"技术\"" | "\"投诉\""
risk ::= "\"low\"" | "\"medium\"" | "\"high\""
human ::= "0" | "1"
ws ::= [ ]*
'''

def main():
    if not MODELS:
        print('没有 GGUF 模型'); return
    from llama_cpp import Llama, LlamaGrammar
    grammar = LlamaGrammar.from_string(GRAMMAR)
    rows = []
    for mp in MODELS:
        size_gb = os.path.getsize(mp) / 1e9
        print(f'\n{"="*70}\n模型: {os.path.basename(mp)}  权重体积 {size_gb:.2f} GB\n{"="*70}')
        try:
            n_threads = int(os.environ.get('N_THREADS', '4'))  # KX-7000 是 2x4 核簇，8 线程会崩
            llm = Llama(model_path=mp, n_ctx=2048, n_threads=n_threads, n_batch=256, verbose=False, seed=0)
        except Exception as e:
            print('加载失败:', e); continue

        # ---- 1) 纯 decode 速度 (生成 128 token，测权重带宽上限) ----
        t0 = time.perf_counter()
        r = llm('用中文写一段关于秋天的散文，约 150 字。', max_tokens=128, temperature=0.7)
        t1 = time.perf_counter()
        usage = r['usage']
        dec_tok = usage['completion_tokens']
        dec_s = t1 - t0
        print(f'[decode] 生成 {dec_tok} tok 用时 {dec_s:.2f}s -> {dec_tok/dec_s:.2f} tok/s')

        # ---- 2) Jev 风格决策：约束解码 + 短输出 ----
        prompt = PROMPT_TMPL.format(sys=SYS, email=EMAIL)
        n_prompt = len(llm.tokenize(prompt.encode()))
        lat = []
        for i in range(3):
            t0 = time.perf_counter()
            out = llm(prompt, max_tokens=48, temperature=0.0, grammar=grammar)
            t1 = time.perf_counter()
            lat.append(t1 - t0)
        best = min(lat)
        out_tok = out['usage']['completion_tokens']
        print(f'[决策] 提示 {n_prompt} tok, 输出 {out_tok} tok')
        print(f'       延迟(3次): {[round(x*1000) for x in lat]} ms, 最快 {best*1000:.0f} ms')
        print(f'       输出: {out["choices"][0]["text"].strip()[:110]}')

        # ---- 3) 长提示 (RAG/长工单) 代价 ----
        long_prompt = prompt * 6
        n_long = len(llm.tokenize(long_prompt.encode()))
        t0 = time.perf_counter()
        llm(long_prompt, max_tokens=48, temperature=0.0, grammar=grammar)
        t1 = time.perf_counter()
        print(f'[长上下文] 提示 {n_long} tok -> {t1-t0:.2f}s  (纯 prefill 吞吐约 {n_long/(t1-t0):.0f} tok/s)')

        rows.append(dict(model=os.path.basename(mp), size_gb=round(size_gb,2),
                         decode_tok_s=round(dec_tok/dec_s,2), prompt_tok=n_prompt,
                         decision_ms=round(best*1000), out_tok=out_tok,
                         long_prompt_tok=n_long, long_s=round(t1-t0,2)))
        del llm
    print(f'\n{"="*70}\n汇总\n{"="*70}')
    print(json.dumps(rows, ensure_ascii=False, indent=1))
    json.dump(rows, open('bench_llm_result.json','w'), ensure_ascii=False, indent=1)

if __name__ == '__main__':
    main()
