cd ~/事务/研究jev
export PYTHONPATH=tools
python3 - <<'PY'
import os,time,numpy as np,onnxruntime as ort
from tokenizers import Tokenizer
nt=int(os.environ.get('NT','4'))
tok=Tokenizer.from_file('models/bge-small-zh/tokenizer.json'); tok.enable_truncation(max_length=512)
so=ort.SessionOptions(); so.intra_op_num_threads=nt; so.inter_op_num_threads=1
so.graph_optimization_level=ort.GraphOptimizationLevel.ORT_ENABLE_ALL
s=ort.InferenceSession('models/bge-small-zh/model_quantized.onnx',so,providers=['CPUExecutionProvider'])
txt80='客户反馈收到的商品外包装破损，内部商品也有明显划痕，要求全额退款并赔偿运费。订单下单时间为上周三，物流显示已签收三天，客户情绪比较激动，希望今天内答复，否则将投诉到平台。'
txt20='客户要求退款，订单号 88213，理由是商品有划痕，情绪激动。'
for name,t in (('短句20字',txt20),('中文80字',txt80)):
    for bs in (1,16):
        e=tok.encode_batch([t]*bs)
        f={'input_ids':np.array([x.ids for x in e]),'attention_mask':np.array([x.attention_mask for x in e]),'token_type_ids':np.zeros((bs,len(e[0].ids)),dtype=np.int64)}
        s.run(None,f)
        ts=[]
        for _ in range(8):
            t0=time.perf_counter(); s.run(None,f); ts.append(time.perf_counter()-t0)
        mn=min(ts)
        print(f'  线程{nt}  {name} batch={bs:2d} -> {mn*1000:7.1f} ms, {bs/mn:6.1f} 句/s')
PY
