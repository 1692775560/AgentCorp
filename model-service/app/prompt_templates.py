"""
model-service/app/prompt_templates.py
系统提示与评估 prompt 构造（架构 §2.3 / PRD §5）。

强制模型输出六维 JSON，缓解 R4 漂移（结构化解析 + 重试）。
"""
from __future__ import annotations

from typing import List

from .schemas import CandidateProfile, UserPreference

# 系统提示：明确要求仅输出结构化 JSON
SYSTEM_PROMPT = """你是一位全模态 HR 总监，由 MiniCPM-o 4.5 驱动。
你将消费候选 agent 的多模态简历（视频/语音/图像/代码/文本），
对其能力进行跨模态评估，并严格按以下 JSON 结构输出（不要输出 JSON 以外的任何内容）：

{
  "radar": {
    "task": 0.0,        // 任务胜任力 0-5
    "quality": 0.0,     // 产出质量 0-5
    "comm": 0.0,        // 表达沟通 0-5
    "creativity": 0.0,  // 创意差异化 0-5
    "reliability": 0.0, // 可靠性 0-5
    "cost": 0.0         // 性价比 0-5
  },
  "verdict": "MVP",     // MVP | OBSERVE | FIRED
  "confidence": 0.0,    // 整体置信度 0-1
  "evidence_trace": ["维度1的证据...", "维度2的证据..."],
  "narration": "面向用户的口头讲解文本",
  "audio_script": "用于语音合成的口播文本"
}

评分要求：
- 从多模态证据推断，而非仅读文本声明。
- 交叉验证：视频/语音中的 claim 是否在代码/文本中兑现（claim≠demo 视为注水）。
- 六维均为 0–5，0.5 步进。
"""


def _fmt_preference(pref: UserPreference) -> str:
    return (
        f"用户偏好：审美={pref.aesthetic.value}，预算上限={pref.budget_max}，"
        f"技术栈偏好={pref.preferred_stack}，权重={pref.weight.model_dump()}"
    )


def build_evaluation_messages(
    candidate: CandidateProfile, preference: UserPreference
) -> List[dict]:
    """
    构造评估消息列表（多模态消息需由真实推理栈补全 content 字段）。
    此处仅拼装文本侧说明与系统提示，视频/语音/图像/代码作为多模态 content 由
    evaluator.load_media 注入。
    """
    user_text = (
        f"请评估候选：{candidate.name}（id={candidate.id}）。\n"
        f"自声明标签：{candidate.declared_tags}，声明预算：{candidate.declared_budget}。\n"
        f"文本 persona：\n{candidate.persona_text.content}\n\n"
        f"{_fmt_preference(preference)}\n\n"
        "（视频/语音/作品图/代码库已作为多模态输入提供，请跨模态交叉验证后输出 JSON。）"
    )
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]
