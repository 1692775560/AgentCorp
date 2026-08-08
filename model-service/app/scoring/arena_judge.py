"""
model-service/app/scoring/arena_judge.py
Arena 个性化对决的 LLM-as-judge 裁判（设计 §2.3 / 决策 D2/D4）。

与 craft_judge 的边界：
- 题源：用户需求（开卷个性化）而非题库闭卷题；
- **无参考答案锚定**（不 import craft_judge.SYSTEM_PROMPT，不读 reference）；
- 评分语义：需求贴合度（craft 维 + fit 需求贴合维）而非标准化能力；
- 共享设施：judge_backend（唯一推理入口/门禁）、_extract_json 解析铁律、
  越界维丢弃、未覆盖维不进分、hit 必须 quote。

客观分汇总（objective_total，供展示与客观 Elo 辅榜）：
    dims 均值（JOB_CRAFT_DIMS 子集，0–5）与 fit（0–5）加权，
    规则：objective_total = round(0.6 * mean(dims) + 0.4 * fit, 1)
    （权重偏客观维，fit 为需求贴合辅助维，体现「个性化但以能力为本」）。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Dict, List, Optional

from ..judge_backend import JudgeCompletion, JudgeUnavailable, get_backend
from .registry import JOB_CRAFT_DIMS

logger = logging.getLogger("arena_judge")

FIT_WEIGHT = 0.4
DIMS_WEIGHT = 0.6


# 新的裁判 prompt：维度限定 JOB_CRAFT_DIMS[job_type] 子集 + fit 维；
# 同需求对所有 agent 用同一份 rubric 文本（不按答案个性化）。
SYSTEM_PROMPT = """你是 AgentCorp 的 Arena 个性化对决裁判，由 MiniCPM-o 4.5 驱动。
你的任务：针对用户的原始需求，对候选 agent 的实施方案（按工种产出）评判需求贴合度。

铁律（违反即为无效评分）：
1. 只依据答案实际内容判定，不猜测候选的意图、不因表述自信而加分。
2. 每条评分要点必须给出 hit（是否兑现）与 quote（答案中的原文片段，
   最多 40 字）。找不到原文支撑的要点，hit 必须为 false，quote 留空。
3. 只对「本题考查维度」打分。未列出的维度一律不要出现在 dims 中。
4. 空口承诺（如「已充分测试」「保证专业」）但无具体内容的，
   必须在 padding 中标注，并压低相关维度分数。
5. 分数为 0–5，0.5 步进。参照锚点：
   0–1 未作答或完全偏离；1.5–2 只有方向没有可执行内容；
   2.5–3 部分要点兑现；3.5–4 多数要点兑现且具体；
   4.5–5 全部要点兑现且给出可核验细节。
6. 本场景【无参考答案】：这是用户的个性化需求，没有标准答案。
   评分依据是「该方案对该需求的贴合程度」+「工种可执行性」，
   严禁照抄任何外部模板句式冒充作答。

严格按以下 JSON 输出，不要输出 JSON 以外的任何内容：
{
  "dims": {"<维度键>": 0.0},
  "checkpoints": [{"checkpoint": "原文照抄要点", "hit": true, "quote": "答案片段"}],
  "padding": {"detected": false, "note": ""},
  "fit": 0.0,
  "confidence": 0.0
}"""


def build_arena_messages(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer: str,
) -> List[dict]:
    """构造评分消息（需求 + 题面 + 工种维度 rubric + 候选答案，无参考答案）。"""
    dims = JOB_CRAFT_DIMS.get(job_type, [])
    dim_block = "\n".join(f"- {d}" for d in dims) or "-（工种无维度定义）"
    user_text = (
        f"【用户原始需求】\n{requirement_text.strip() or '(空)'}\n\n"
        f"【题面（需求 + 工种模板）】\n{task_prompt.strip()}\n\n"
        f"【本题考查维度（dims 只能包含这些键 + fit）】\n{dim_block}\n- fit（需求贴合度）\n\n"
        f"【候选答案】\n{answer.strip() or '(候选未作答)'}\n\n"
        "请按系统提示的 JSON 结构输出评分。"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def _extract_json(raw: str) -> dict:
    """从模型输出抽取 JSON（与 craft_judge 同铁律：容忍代码块包裹与前后赘余）。"""
    text = (raw or "").strip()
    matched = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if matched:
        text = matched.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"裁判输出无法解析为 JSON：{exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("裁判输出的顶层结构不是对象")
    return data


def _clamp_half_step(value: float) -> float:
    """夹到 [0,5] 并对齐 0.5 步进。"""
    clamped = max(0.0, min(5.0, float(value)))
    return round(clamped * 2) / 2


def parse_arena_output(raw: str, job_type: str) -> dict:
    """
    解析裁判输出。越界维度丢弃；缺失目标维记 unscored_dims；hit 必须带 quote。
    返回 dict（可直接并入 ArenaCandidateAnswer.judgement）。
    """
    data = _extract_json(raw)
    allowed = set(JOB_CRAFT_DIMS.get(job_type, []))

    dims: Dict[str, float] = {}
    raw_dims = data.get("dims")
    if isinstance(raw_dims, dict):
        for key, value in raw_dims.items():
            if key not in allowed:
                logger.warning("裁判输出越界维度 %s，已丢弃（工种 %s）", key, job_type)
                continue
            try:
                dims[key] = _clamp_half_step(value)
            except (TypeError, ValueError):
                logger.warning("维度 %s 分数非法（%r），已丢弃", key, value)

    checkpoints: List[dict] = []
    raw_cps = data.get("checkpoints")
    if isinstance(raw_cps, list):
        for item in raw_cps:
            if not isinstance(item, dict):
                continue
            quote = str(item.get("quote", "")).strip()
            hit = bool(item.get("hit")) and bool(quote)
            checkpoints.append(
                {
                    "checkpoint": str(item.get("checkpoint", "")).strip(),
                    "hit": hit,
                    "quote": quote,
                }
            )

    padding = data.get("padding")
    padding_detected = False
    padding_note = ""
    if isinstance(padding, dict):
        padding_detected = bool(padding.get("detected"))
        padding_note = str(padding.get("note", "")).strip()

    try:
        fit = _clamp_half_step(data.get("fit", 0.0))
    except (TypeError, ValueError):
        fit = 0.0
    try:
        confidence = max(0.0, min(1.0, float(data.get("confidence", 0.0))))
    except (TypeError, ValueError):
        confidence = 0.0

    return {
        "dims": dims,
        "unscored_dims": [d for d in sorted(allowed) if d not in dims],
        "checkpoints": checkpoints,
        "padding_detected": padding_detected,
        "padding_note": padding_note,
        "fit": fit,
        "confidence": confidence,
    }


def objective_total(judgement: dict) -> float:
    """客观分汇总：dims 均值 + fit 加权（0.6/0.4），保留 1 位小数。"""
    dims = judgement.get("dims") or {}
    values = [float(v) for v in dims.values() if isinstance(v, (int, float))]
    mean_dims = sum(values) / len(values) if values else 0.0
    fit = float(judgement.get("fit") or 0.0)
    return round(DIMS_WEIGHT * mean_dims + FIT_WEIGHT * fit, 1)


def judge_arena_answer(
    requirement_text: str,
    task_prompt: str,
    job_type: str,
    answer: str,
) -> dict:
    """
    对单个候选答案做 Arena 客观评判（需 judge 后端可用）。

    后端不可用时抛 JudgeUnavailable —— 调用方（routes/arena.py）映射 503。
    """
    backend = get_backend()
    if not backend.available:
        raise JudgeUnavailable(
            f"Arena 客观评判需要可用的 judge 后端（当前 {backend.name} 不可用）。"
            "请配置 JUDGE_BACKEND=http 或 local。"
        )
    completion: JudgeCompletion = backend.complete(
        build_arena_messages(requirement_text, task_prompt, job_type, answer)
    )
    judgement = parse_arena_output(completion.text, job_type)
    judgement["backend"] = completion.backend
    judgement["ttft_ms"] = completion.ttft_ms
    judgement["latency_ms"] = completion.latency_ms
    judgement["objective_total"] = objective_total(judgement)
    return judgement
