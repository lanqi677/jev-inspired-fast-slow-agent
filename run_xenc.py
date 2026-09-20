cd ~/事务/研究jev
export PYTHONPATH=tools
python3 - <<'PY'
import time,numpy as np,onnxruntime as ort
from tokenizers import Tokenizer
tok=Tokenizer.from_file('models/bge-small-zh/tokenizer.json'); tok.enable_truncation(max_length=512)
so=ort.SessionOptions(); so.intra_op_num_threads=8; so.inter_op_num_threads=1
s=ort.InferenceSession('models/bge-small-zh/model_quantized.onnx',so,providers=['CPUExecutionProvider'])
state='客户反馈收到的商品外包装破损，内部商品也有明显划痕，要求全额退款并赔偿运费。订单下单时间为上周三，物流显示已签收三天，客户情绪比较激动，希望今天内答复，否则将投诉到平台。'*3
opts=['点击 申请退款 按钮','点击 联系客服 按钮','点击 提交工单 按钮','点击 查看物流 按钮','点击 返回首页 链接',
      '点击 上传凭证 按钮','点击 确认收货 按钮','点击 取消订单 按钮','点击 评价商品 按钮','点击 下载发票 链接']
for N in (5,10,20,50):
    pairs=[(state,o) for o in (opts*((N//10)+1))[:N]]
    enc=tok.encode_batch([a+"[SEP]"+b for a,b in pairs])
    f={'input_ids':np.array([e.ids for e in enc]),'attention_mask':np.array([e.attention_mask for e in enc]),'token_type_ids':np.zeros((len(enc),len(enc[0].ids)),dtype=np.int64)}
    s.run(None,f); ts=[]
    for _ in range(3):
        t0=time.perf_counter(); s.run(None,f); ts.append(time.perf_counter()-t0)
    mn=min(ts); L=len(enc[0].ids)
    print(f'  交叉编码器 N={N:2d} 选项, 每条 {L} token -> {mn*1000:7.0f} ms  ({mn/N*1000:.0f} ms/选项)')
PY
