"""
model-service/app/scoring/arena_templates.py
需求 → 题面工种模板（设计 §2.2 / 决策 D1）。

纯函数、确定性、零 LLM 调用：用户原话作题干主干，按工种包装成可作答题面。
可比性由「同需求 + 同工种模板 + 同 rubric 裁判」保证（非题面公平）。
反注水探针内嵌（「给出可执行内容，不要空话」「一句话说明如何验证」），
与 craft_judge 的 padding 检测理念一致。
"""
from __future__ import annotations

from typing import Dict

#: 工种 → 产出要求块（模板化，可单测）
JOB_OUTPUT_REQUIREMENTS: Dict[str, str] = {
    "code": (
        "- 方案要点 + 核心代码/伪代码 + 你会写的测试\n"
        "- 直接针对需求作答，不要泛泛介绍自己；空话将被判定为注水。\n"
        "- 用一句话说明你如何验证方案有效。"
    ),
    "text": (
        "- 文案初稿 + 措辞依据\n"
        "- 直接针对需求作答，不要泛泛介绍自己；空话将被判定为注水。\n"
        "- 用一句话说明你如何验证方案有效。"
    ),
    "image": (
        "- 可执行参数（构图/色板/光线）+ 正向/负向提示词\n"
        "- 直接针对需求作答，不要泛泛介绍自己；空话将被判定为注水。\n"
        "- 用一句话说明你如何验证方案有效。"
    ),
}

TEMPLATE = """【任务背景（用户原始需求）】
{requirement_text}
【任务要求】
- 请基于上述需求给出你的实施方案/产出（按工种）：
{output_requirements}
"""


def build_task_prompt(requirement_text: str, job_type: str) -> str:
    """
    由用户需求 + 工种模板渲染题面（确定性纯函数）。

    参数校验与路由层约定一致：job_type 仅接受 code/text/image；
    非法工种由调用方（routes/arena.py）在 422 前拦截，此处直接抛 ValueError
    以便纯函数单测覆盖。
    """
    requirement = (requirement_text or "").strip()
    if not requirement:
        raise ValueError("需求文本不能为空")
    job = (job_type or "").strip().lower()
    if job not in JOB_OUTPUT_REQUIREMENTS:
        raise ValueError(f"不支持的工种：{job_type}")
    return TEMPLATE.format(
        requirement_text=requirement,
        output_requirements=JOB_OUTPUT_REQUIREMENTS[job],
    ).strip()


def supported_jobs() -> list:
    """支持的工种列表（供路由校验）。"""
    return sorted(JOB_OUTPUT_REQUIREMENTS.keys())
