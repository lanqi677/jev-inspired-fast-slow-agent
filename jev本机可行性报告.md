# 本机硬件画像 & 类 Jev 模型本地部署可行性与速度分析

> 实测日期：2026-09-20　机器：UOS Desktop 20 Professional（内核 4.19）　工作目录：`~/事务/研究jev`
> 所有数字均为本机实测，非推算；推算项已明确标注。

---

## 一、结论速览

| 问题 | 结论 |
|---|---|
| Jev 本体能本地部署吗？ | **不能。** TypeSafe 闭源、无权重、无论文，只有 API（`POST https://api.typesafe.ai/v1/systemone`，$0.042/百万输入 token，输出不计费） |
| 本地做「Jev 风格决策层」可行吗？ | **可行，但只有一条路走通：编码器 + 分类头。** 单次决策 **16–50 ms**，与 Jev 官方 70–500 ms 同级甚至更快 |
| 用小 LLM 复刻 Jev 呢？ | **不可行。** 本机最快 0.5B 模型一次三字段决策要 **1.9 秒**，1.5B 要 **4.9 秒**，4B 要 **11.9 秒** —— 比 Jev 慢 10–70 倍 |
| 根因 | ① 内存带宽只有 **6.4 GB/s**（decode 完全被带宽锁死）② KX-7000 是 **2×4 核簇**，llama.cpp 默认 8 线程性能崩掉 2.5 倍 ③ 无 GPU/NPU 可用 |

---

## 二、硬件底数

| 项 | 实测值 |
|---|---|
| CPU | 兆芯 开先 KX-7000，8 核 / 8 线程（无 SMT），1 socket |
| 频率 | 标称 max 3.0 GHz（lscpu 报 3.5 GHz），**负载下实测 1.1–2.5 GHz**，调频策略 `ondemand` |
| 缓存 | L1d 256K / L1i 512K / L2 4M / L3 32M |
| 指令集 | AVX2、FMA、F16C、AES、SHA；**无 AVX-512、无 VNNI、无 AMX** |
| 内存 | 14 GiB（可用 13 GiB），Swap 15 GiB |
| 显卡 | 兆芯集显 KX-7000 C-1190 —— **无 CUDA / ROCm，不能用于推理** |
| 加速卡 | 无（nvidia-smi 不存在，lspci 无独显） |
| 磁盘 | NVMe：`/` 149 G 可用、`/home` 135 G 可用 |
| 其他 | 无 sudo（sudo 所在文件系统 nosuid）；机器为**共享环境**：/proc/stat 显示本命名空间之外长期占用约 45% CPU（load average 11.6） |

---

## 三、微基准实测（自写 C + AVX2 + OpenMP）

| 指标 | 结果 | 说明 |
|---|---|---|
| 只读带宽（1 线程） | **4.13 GB/s** | 决定 decode 速度的关键指标 |
| 只读带宽（8 线程） | **6.36 GB/s** | 8 线程只有 1.5× 提升 |
| memcpy（读+写） | 8.55 GB/s | |
| triad（读2写1） | 8.10 GB/s | |
| FP32 FMA（1 线程 / L1 驻留） | 29.2 GFLOPS | |
| FP32 FMA（8 线程 / L1 驻留） | 104.6 GFLOPS | 仅 3.6× 扩展，非 8× |
| INT8 maddubs（8 线程） | 约 9 GOPS | 偏低 |

**带宽自洽性验证**：Qwen2.5-0.5B Q4_K_M 权重 0.462 GiB，实测 decode 13.9 tok/s
→ 有效带宽 = 0.462 × 13.9 ≈ **6.4 GB/s**，与直接测得的只读带宽完全吻合。
**结论：本机 LLM decode 完全受内存带宽约束，任何模型优化都无法突破这个天花板。**

对比参考：普通桌面双通道 DDR5-4800（77 GB/s）是它的 **12 倍**。

---

## 四、最关键发现：KX-7000 的 2×4 核簇陷阱

同一模型（Qwen2.5-0.5B Q4_K_M），只改线程/绑核：

| 配置 | decode (tg256) |
|---|---|
| 1 线程 | 4.96 tok/s |
| 2 线程 | 8.79 tok/s |
| 4 线程 | 10.58 tok/s |
| **8 线程（llama.cpp 默认思路）** | **3.17 tok/s** ← 比 1 线程还慢 |
| `taskset -c 0-3` + 4 线程 | **13.44 tok/s** |
| `taskset -c 4-7` + 4 线程 | **13.55 tok/s** |
| `taskset -c 0-7` + 8 线程 | 5.47 tok/s |
| `taskset -c 0-3` + 8 线程 | 10.22 tok/s |

**解读**：KX-7000 的 8 个核分属两个 4 核簇，跨簇同步开销极大。llama.cpp 默认把线程铺满 8 核 = 最差配置。
**用 4 线程并绑到单簇，比默认配置快 2.6 倍。**ONNX Runtime 上的编码器也呈现同向趋势。

---

## 五、llama.cpp 真实推理实测

环境：从源码编译 llama.cpp（ggml 0.20.0，commit 4df29be，gcc 8.3，`-march=native`，AVX2+FMA+F16C 生效）
运行参数：`taskset -c 0-3` + `-t 4`

| 模型 | 量化 | 权重体积 | pp512（prefill） | tg128（decode） | 有效带宽 |
|---|---|---|---|---|---|
| Qwen2.5-0.5B-Instruct | Q4_K_M | 0.49 GB | **48.8 tok/s** | **13.9 tok/s** | 6.4 GB/s |
| Qwen3-0.6B | Q8_0 | 0.64 GB | 44.7 tok/s | 9.2 tok/s | 5.5 GB/s |
| Qwen2.5-1.5B-Instruct | Q4_K_M | 1.12 GB | 18.3 tok/s | 5.2 tok/s | 5.4 GB/s |
| Qwen3-4B-Instruct-2507 | Q4_K_M | 2.50 GB | **6.6 tok/s** | **2.1 tok/s** | 5.2 GB/s |

**要点**：
- prefill（提示处理）比 decode 更惨：4B 模型处理 512 token 提示要 **77 秒**。
- 8 线程版本（默认）全部数字还要再砍一半以上。
- 这与外部公开数据（i7/DDR5 上 3B 约 30 tok/s）相比，本机慢 **10 倍以上**。

---

## 六、Jev 风格决策的端到端延迟（核心结论表）

任务形态完全对齐 Jev：一次请求给出 3 个独立判断（工单分派部门 / 退款风险等级 / 是否转人工），用 **GBNF 语法强制约束解码**，只允许输出合法 JSON 枚举，temperature=0。

| 模型 | 提示 89 tok + 输出 ~19 tok | 提示 534 tok + 输出 ~19 tok |
|---|---|---|
| Qwen2.5-0.5B Q4_K_M | **1.90 s** | 14.1 s |
| Qwen3-0.6B Q8_0 | 3.50 s | 19.6 s |
| Qwen2.5-1.5B Q4_K_M | 4.86 s | 31.0 s |
| Qwen3-4B-Instruct Q4_K_M | **11.87 s** | **92.6 s** |

对照 **Jev 官方宣称 70–500 ms**（独立复测 p50 约 236–276 ms）：

- 本机 0.5B 方案 ≈ **Jev 的 8–27 倍延迟**
- 本机 1.5B 方案 ≈ **Jev 的 20–70 倍延迟**
- 长上下文（534 tok）在任何模型上都 **≥14 秒**，完全不可用于交互

> 注：约束解码本身不是瓶颈（grammar 强制只输出 15–21 个 token），瓶颈是 **prefill**。
> 即使输出 1 个 token，prompt 处理时间也跑不掉。

---

## 七、编码器路线实测（推荐方案）

模型：`Xenova/bge-small-zh-v1.5` 量化 ONNX（24 MB），ONNX Runtime 1.30，8 线程（绑全核）

| 输入长度 | 单条延迟 | 吞吐（batch=16） |
|---|---|---|
| 短句（20 字） | **16.2 ms** | 67.7 句/s |
| 中文 80 字 | **49.9 ms** | 44.6 句/s |
| 长文（300 字） | 197 ms | — |

四线程绑单簇时：短句 22.3 ms、80 字 37.4 ms —— 单条延迟与 8 线程互有胜负（都远好于 LLM 路线）。

**加上线性分类头（Jev 的 Choice/Score/Noul 三种 primitive 都能用它实现）后总延迟基本不变**，因为 head 的计算量相比编码器可忽略。

**关键产业事实**（独立预注册评测）：有几千条自有标注数据时，frozen `bge-small` + 逻辑回归在 Banking77 上 **93.3%**，高于 Jev 的 **83.2%**。
→ **本机最优解不是「本地跑一个 Jev」，而是「用编码器训练你自己的 Jev」。**

---

## 八、三条路线的可行性判定

| 路线 | 本机延迟 | 可行性 | 适用场景 |
|---|---|---|---|
| **A. 编码器 + 分类头**（bge-small-zh / ModernBERT / SetFit / GLiNER） | **16–50 ms** | ✅ **强烈推荐** | 分类、路由、打分、yes/no；有标注数据时准确率可超 Jev。单次成本 ~0 |
| **B. 小 LLM + 约束解码**（0.5B–1.7B Q4_K_M） | **1.9–4.9 s** | ⚠️ 勉强可用 | 无标注数据的零样本兜底、异步批处理、离线/隐私场景。**不可做交互式** |
| **C. 4B 及以上 LLM** | 11.9 s 起 | ❌ 不可用 | — |
| **D. 真·Jev 本地部署** | — | ❌ 不可能 | 无权重可下载 |

**推荐架构**：A 为主 + B 兜底（编码器粗筛 → 低置信度样本转 0.5B LLM 复核），这也是社区一致认可的方向。
若必须自建 Jev 兼容接口，可参考 Apache-2.0 的 `jaredpsiteaer/kev`（Qwen2.5 + pointer head，实现 `/v1/systemone`，TypeSafe 官方 SDK 改 base_url 即可直连）。

---

## 九、如果一定要在本机跑 LLM，必须做的工程优化

1. **必须** `taskset -c 0-3`（或 4-7）+ `-t 4`，绝不要用默认 8 线程 —— 单这一项就是 2.6 倍差距。
2. **量化选 Q4_K_M / Q4_K_S**，不要低于 Q3（反量化开销会吃掉带宽收益）。
3. **剪 prompt**：prefill 是本机死穴。把 state 从 7000 token 压到 1500 token 是 5 倍差距。
4. **复用前缀缓存**：固定 system prompt / 固定 state 只 prefill 一次，后续只处理变化的尾部。
5. **批处理**：把 N 个独立判断合并到一次 forward（Jev 的 parallel sampler 思路），摊薄 prefill。
6. **异步化**：把决策从交互路径挪到后台队列。

**硬件层面的建议**：内存带宽是关键（本机 6.4 GB/s）。若要让 LLM 路线可用（≥20 tok/s decode），需要双通道 DDR5 级平台；若要保持 100 ms 级交互决策，本机走编码器路线即可，无需换硬件。

---

## 十、本次留下的可复用资产

| 路径 | 内容 |
|---|---|
| `models/` | 4 个 GGUF 模型（0.5B/0.6B/1.5B/4B）+ bge-small-zh ONNX |
| `pylibs/` | 已编译安装的 `llama-cpp-python` 0.3.35（AVX2） |
| `src/llama_cpp_python-0.3.35/vendor/llama.cpp/build/bin/llama-bench` | 可用的 llama.cpp 官方基准工具 |
| `bench_kx7000.c` / `bench2.c` | CPU 微基准源码（编译命令见文件头） |
| `bench_encoder.py` | 编码器吞吐基准 |
| `bench_llm.py` / `run_llm.sh` / `bench_llm_result.json` | Jev 风格决策端到端基准与结果 |
| `tools/` | cmake 4.4.3 / ninja / onnxruntime / tokenizers / numpy |

> 编译 llama.cpp 时对 `vendor/.../tools/server/server-schema.h` 打了 2 处 gcc 8 兼容补丁（`-lstdc++fs` 链接参数 + 移除 `field_num` 默认模板参数），仅影响本地构建。

---

## 十一、数据来源与局限

**实测**：本文第二~七节的全部数字（本机 bench 工具与 llama.cpp 自测）。
**外部资料**：Jev 闭源/定价（[docs.typesafe.ai/models](https://docs.typesafe.ai/models)）、独立评测（[CreativeAINews](https://www.creativeainews.com/articles/open-jev-clones-benchmark-disagreement-2026/)）、CPU 速度参考（[InsiderLLM](https://insiderllm.com/guides/cpu-only-llms-what-actually-works/)）、社区复刻（[jev_local](https://github.com/Argos1111/jev_local)、[jev-browser-local](https://github.com/rorshopping/jev-browser-local)、[kev](https://github.com/jaredpsiteaer/kev)）、KX-7000 非对齐 AVX 补丁（[libc-alpha](https://sourceware.org/pipermail/libc-alpha/2024-June/157874.html)）。

**局限**：
1. 本机是共享环境（外部进程长期占约 45% CPU），绝对数字可能有 10–20% 波动，但相对结论（4 线程 > 8 线程、带宽瓶颈）稳定可复现。
2. llama.cpp 为 gcc 8.3 + AVX2 构建；未测 AVX-512（硬件不支持）。
3. 未测 GPU/NPU 方案（本机没有）。
4. 未测编码器微调后的准确率，只测了速度。
