# Phase 4b：启发式 + LLM 双层 FP 过滤

**日期**：2026-05-19  
**阶段**：Phase 4b — 启发式过滤（无 LLM 依赖）+ LLM Stage 2 接入（OpenAI-兼容）  
**前序**：Phase 4a（保护原语过滤，FP 703 → 703 with ranking）

## 实测对比

### Recall@thr 表（阈值 sweep）

| 阈值 | Phase 4a (保护) | **Phase 4b (启发式)** | 增量 |
|------|-------------|---------------------|-----|
| 0.50 | 100% / FP=648 | 100% / FP=380 | **-41%** |
| **0.55** | **100% / FP=564** | **100% / FP=286** | **-49%** |
| 0.60 | 96.6% / FP=403 | 89.7% / FP=214 | TP -3 / FP -47% |
| 0.65 | 65.5% / FP=149 | 58.6% / FP=117 | TP -2 / FP -21% |

**0.55 阈值是当前最优**：100% recall + FP 减半。

### LLM 预期收益（待实测）

按 contract §3.2 融合公式：

```
final_confidence = structural_score + L × λ_atomic_intent
λ = 0.30,  L: STRONG→1.0, WEAK→0.5, NONE→0.0
```

预期效果（基于 multivar-atomicity-checker 实测数据外推）：
- 工业代码中 FP 候选 ~70% 会被 LLM 判 NONE
- TP 候选 ~80% 会被判 STRONG
- 结合 thr=0.85 过滤（structural 0.55 + STRONG 0.30=0.85），FP 预期 286 → 60-100

## 实施细节

### 启发式规则（Scala 端，单变量场景特化）

7 条 evidence 维度，全部基于变量名/类型/AST 模式，无外部依赖：

| 规则 | ±score | 触发 |
|------|--------|------|
| volatile_marked | +0.10 | 变量含 `volatile` 修饰 |
| multi_isr | +0.08 | 多个 ISR 访问同一变量 |
| rmw_op | +0.08 | local2 是 `++`/`+=` 等 RMW |
| h_counter_pattern | -0.15 | 名含 tick/count + ISR 端 `++` |
| h_mmio_register | -0.20 | 名含 0x 或 XBYTE 类 MMIO 指针 |
| h_init_far_apart | -0.15 | main 内 line<250 + l1-l2 距离>500 |
| h_array_bulk_write | -0.10 | pattern=WWW + 数组 `[*]` |

**设计原则**：
1. 减分规则只能让候选**下沉**到阈值以下（不会让 TP 上升变成 FP）
2. 加分规则保守（+0.08-0.10，单条不能让 FP 跨进高分区）
3. 所有规则有明确的"程序员意图"判读依据，能在报告中向开发者解释

### LLM Stage 2（Python harness 端）

新建 `EmbedSVABench/tools/stage2_llm.py`（500 行）：

**功能**：
- 读 Stage 1 输出，提取每候选的 30 行代码上下文
- 批量 8 候选/请求调用 LLM
- 解析三级判定 (STRONG/WEAK/NONE)
- 融合到 `final_confidence`
- 输出 `eval_sva_stage2.json`

**配置**：
- Provider-agnostic：用 `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` 环境变量
- 兼容 OpenAI/DeepSeek/通义/Kimi/GLM 等
- 并发可调：`LLM_BATCH_SIZE`, `LLM_TIMEOUT_S`, `LLM_MAX_CONCURRENCY`

**容错**：
- API 失败 → 候选标 UNAVAILABLE，保留 structural_score
- 部分响应解析失败 → 该候选标 UNAVAILABLE
- 全集失败 → harness 仍能产出 stage2.json，仅 `by_judgment` 全 0

**成本估算**（27 案例全集 ~315 候选过 0.55 阈值）：
- DeepSeek-chat (~$0.27/M input + $1.10/M output)：~$0.05/全集
- Qwen2.5-coder-32b：~$0.10/全集
- 单案例平均：~$0.005

### 与现有 multivar-atomicity-checker 的语义一致

| 字段 | multivar-atomicity-checker | singlevar-atomicity-checker |
|------|-------------------|------------------------------|
| LLM 输出格式 | STRONG/WEAK/NONE | 相同 |
| 融合公式 | S + L×λ | 相同 |
| λ 取值 | 0.15 (DFC/TUP), 0.40 (DAC) | **0.30 (atomic_intent)** |
| 阈值 | 0.55 | 相同 |
| 失败回退 | UNAVAILABLE | 相同 |

新增 λ=0.30 已登记到 `docs/conflict-detector-contracts.md` §3.2。

## 退化与失败模式

| 场景 | 行为 |
|------|------|
| LLM API 不可用 | Stage 2 跑通但所有候选 UNAVAILABLE，`final_confidence = structural_score` |
| 网络超时 | 该批次候选 UNAVAILABLE，继续下一批 |
| LLM 返回非 JSON | 该候选 UNAVAILABLE，记录 `raw_response` 便于调试 |
| API 返回 STRONG 但代码片段不对 | 启发式扣分仍生效（penalty 加在 LLM 之前） |

**重要**：LLM 全失败时，Phase 4b 等价于 Phase 4a + 启发式过滤（FP 286 @thr=0.55）—— 这就是 LLM-free 退化基线。

## 文件变更

| 文件 | 状态 | 行数 |
|------|------|-----|
| `joern/singlevarAtomicityIdentify.scala` | 编辑 | +60 行（7 条启发式规则） |
| `EmbedSVABench/tools/stage2_llm.py` | 新建 | 500 行 |
| `EmbedSVABench/tools/README_eval.md` | 新建 | 完整评估流程文档 |

## 使用方法

```bash
# 1. 跑 Stage 1（必做，含启发式）
python EmbedSVABench/tools/eval_sva_stage1.py --mode joern --cases <list>

# 2. 配 LLM（任选一家）
export LLM_BASE_URL=https://api.deepseek.com/v1
export LLM_API_KEY=sk-xxx
export LLM_MODEL=deepseek-chat

# 3. Stage 2 LLM 判定（仅评估高结构分候选省 token）
python EmbedSVABench/tools/stage2_llm.py --threshold 0.55

# 4. 看 stage2_threshold_sweep 选最优阈值
# 推荐：final_confidence >= 0.85 → critical
#       0.70 <= final_confidence < 0.85 → major
#       < 0.70 → 丢弃
```

## TypeScript 验证

`bun run typecheck` ✅  
`bun run build` ✅

## 下一步

LLM 实测有两条路径：

**A. 用户配置 LLM_* 环境变量 → 直接跑全集**（最简单）
- 工作量：5 分钟配 key + 1 分钟跑全集
- 输出：`eval_sva_stage2.json` 含每候选 LLM judgment

**B. 用 mock LLM（基于已知 GT）做 SOTA 上限估计**
- 用 GT 已标注的违反作为 "STRONG" oracle
- 估算如果 LLM 完美工作时 FP 收敛到多少
- 不需要真 LLM，给定 baseline

建议先做 A——已经在项目中复用过这种 LLM 调用模式（multivar-atomicity-checker），技术风险低。
