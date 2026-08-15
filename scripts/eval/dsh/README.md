# AgentCorp × DeepSeek Harness — Option 2 评测探针

> **目的**：验证「AgentCorp 的科学评委方法论（pass^k / 多数裁决 / Krippendorff α）能被
> 一个外部 eval 编排器（dsh）消费并产出结构化报告」。这是 `deepseek-harness-integration.md`
> §4.4 的探针步骤，是 Option 2 可行性的验收线。

## 设计要点
- **零产品耦合**：本目录（`scripts/eval/dsh/`）完全独立，不进入 `src/` 编译图，
  不 `import` 任何 dsh / cordis 符号。AgentCorp 产品代码零改动。
- **评分科学真源**：`passK` / `majorityVerdict` / `krippendorffAlphaMulti` 的纯函数核心
  在 `src/engine/evaluation/{passK,ranking}.ts` 与 `src/services/judgeEnsemble.ts` 有 TS 实现；
  本探针用标准库 python 1:1 重实现（逻辑严格对齐），生产环境由 `model-service :8000` 持有真源。
- **两种运行模式**：
  1. `run_probe.py` —— 自包含 runner，用**进程内 mock judge** 跑通整条 eval loop，
     不依赖 dsh、也不需启动 model-service。用于本地快速验证。
  2. `agentcorp_eval_provider.py` —— **真实** provider，HTTP 调 `/api/chat-judge`
     （k 次重复采样 + 聚合），供已安装的 dsh 作为 eval provider 调用。

## 运行（探针模式，无需 dsh）
```bash
# 用 Python 3.11+ 运行（本环境可用托管 Python；从仓库根目录执行）
python scripts/eval/dsh/run_probe.py
```
预期输出：每个 sample 的 `meanRadar / verdict / confidence / pass^k(allPass,passRate,k) /
dimPassRate / α(Krippendorff)`，以及末尾 `探针总判定: PASS ✅`（§4.4 验收线：产出
pass_k / verdict / agreement_alpha）。

## 切到真实 dsh（当 dsh 已安装）
1. 确保 `model-service :8000` 的 `/api/chat-judge` 可达（或 Host API 代理 `127.0.0.1:3210`）。
2. 把 `AgentCorpEvalProvider` 注册为 dsh 的 eval provider（参考 `profile.probe.yml` 的 patch 项）。
3. 运行：`dsh eval --profile profile.probe.yml`。
   dsh 负责 agent 实战考编排 + landlock 沙箱 + 回归集管理；评分科学完全一致。

## 文件清单
- `agentcorp_eval_provider.py`：真实 eval provider + 纯函数聚合核心（对齐 TS）。
- `run_probe.py`：自包含 mock runner（探针默认入口）。
- `profile.probe.yml`：最小 dsh profile（patch 示例）。
- `benchmarks/probe/sample.jsonl`：固定样本（取自面试 transcript 形态）。

## 验收线
探针通过 = Option 2 可行 → 随后扩到 G12 回归集（生产面试回流）/ G14 tau²-bench / AgentBoard。
