"""编码器路线实测：bge-small-zh(量化 ONNX) 在本机的吞吐与延迟
Jev 风格决策 (=encoder + 线性分类头) 的代表。"""
import time, sys, numpy as np, onnxruntime as ort
sys.path.insert(0, 'tools')
from tokenizers import Tokenizer

MODEL_DIR = 'models/bge-small-zh'
tok = Tokenizer.from_file(f'{MODEL_DIR}/tokenizer.json')
tok.enable_padding(length=None)
tok.enable_truncation(max_length=512)

so = ort.SessionOptions()
so.intra_op_num_threads = 8
so.inter_op_num_threads = 1
so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
sess = ort.InferenceSession(f'{MODEL_DIR}/model_quantized.onnx', so, providers=['CPUExecutionProvider'])
print('ONNX 输入:', [(i.name, i.shape) for i in sess.get_inputs()])

def run(texts, iters=5):
    enc = tok.encode_batch(texts)
    ids = np.array([e.ids for e in enc], dtype=np.int64)
    mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
    tt = np.zeros_like(ids)
    feeds = {'input_ids': ids, 'attention_mask': mask, 'token_type_ids': tt}
    sess.run(None, feeds)  # warmup
    ts = []
    for _ in range(iters):
        t0 = time.perf_counter(); sess.run(None, feeds); ts.append(time.perf_counter() - t0)
    return min(ts)

# 典型决策输入：一封客服邮件 / 一段工单描述（中文 60-120 字）
samples = {
    '短句(20字)': ['客户要求退款，订单号 88213，理由是商品有划痕，情绪激动。'] * 1,
    '中文本(80字)': ['客户反馈收到的商品外包装破损，内部商品也有明显划痕，要求全额退款并赔偿运费。订单下单时间为上周三，物流显示已签收三天，客户情绪比较激动，希望今天内答复，否则将投诉到平台。'] * 1,
    '长文本(300字)': ['客户反馈收到的商品外包装破损，内部商品也有明显划痕，要求全额退款并赔偿运费。订单下单时间为上周三，物流显示已签收三天，客户情绪比较激动，希望今天内给出答复，否则将投诉到平台。此外客户提到此前已经联系过两次客服，第一次被告知需要等待 48 小时，第二次没有人接听，因此对服务非常不满。客户还上传了三张照片作为证据，照片显示外箱有明显压痕，商品本体在边角处有约两厘米的划痕。客户表示如果不能全额退款，将要求换货并补偿优惠券。'] * 1,
}
print('\n%s' % ('=' * 62))
print('%-14s %8s %10s %12s %12s' % ('输入', 'batch', '耗时(ms)', '单条延迟(ms)', '吞吐(句/s)'))
print('=' * 62)
for name, base in samples.items():
    for bs in (1, 8, 32):
        texts = (base * bs)[:bs]
        t = run(texts)
        print('%-14s %8d %10.1f %12.2f %12.1f' % (name, bs, t * 1000, t / bs * 1000, bs / t))
print('=' * 62)
