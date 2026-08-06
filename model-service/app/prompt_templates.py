"""
model-service/app/prompt_templates.py
系统提示与评估 prompt 构造（架构 §2.3 / PRD §5）。

强制模型输出六维 JSON，缓解 R4 漂移（结构化解析 + 重试）。
"""
from __future__ import annotations

from typing import List, Optional

from .schemas import CandidateProfile, UserPreference
from .scoring.registry import JOB_CRAFT_DIMS, SUBJECTIVE_DIMS

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
  "audio_script": "用于语音合成的口播文本",
  "craft": {}            // 可选：按工种输出工种专属维（详见下方「工种 craft 子对象」）
}

评分要求：
- 从多模态证据推断，而非仅读文本声明。
- 交叉验证：视频/语音中的 claim 是否在代码/文本中兑现（claim≠demo 视为注水）。
- 六维均为 0–5，0.5 步进。
- craft 子对象为可选项，仅在三阶段评估（按工种）时填写，见下方说明。

【工种 craft 子对象（可选，0–5，0.5 步进）】
若评估任务要求按工种（image / text / code）细分能力，请在 craft 中按对应前缀输出该工种专属维：
- image（图像 agent）：img_composition / img_style_fit / img_fidelity / img_aesthetic_consistency / img_multimodal_follow
- text（文本 agent）：txt_factuality / txt_coherence / txt_tone_fit / txt_info_density / txt_instruction_follow
- code（代码 agent）：code_runnability / code_efficiency / code_test_coverage / code_maintainability / code_security
例：{"craft": {"img_composition": 4.0, "img_style_fit": 4.5, ...}}
若未指定工种或无需细分，省略 craft 字段（不影响六维评分）。

【三条硬规则（必须严格执行）】
1. 声明–交付一致性（注水检测）：视频/语音中的 claim 必须在代码/文本/作品中兑现；
   发现 claim≠demo（夸大、无对应实现）必须降权并在 evidence_trace 标注「注水」。
2. 跨模态自洽：图/文/码/语音多模态之间不得自相矛盾（如风格、事实、能力描述冲突）。
3. 可靠性：评估结论须一致、可复核，不得因表述顺序或随机扰动而漂移、降智。
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


# ======================================================================
# 工种 × 阶段 系统提示构造（T2：craft 子对象 + 三条硬规则）
# ======================================================================
_STAGE_LABEL = {
    "preScreen": "入职前初审（简历/作品集）",
    "interview": "面试（模拟任务交互）",
    "performance": "绩效审核（运行期真实遥测）",
}


def build_stage_system_prompt(job_type: str, stage: str) -> str:
    """
    构造「按工种 + 阶段」的系统提示：在 SYSTEM_PROMPT 基础上，明确要求模型
    在 JSON 中给出对应工种的 craft 子对象（img_*/txt_*/code_* 各 0–5），
    并强调三条硬规则（声明–交付一致性 / 跨模态自洽 / 可靠性）。

    保持既有六维 radar 输出不变，向后兼容（craft 缺失时 parse_output 降级）。
    本函数供 T4 阶段评分管线调用；不改变既有 build_evaluation_messages 行为。
    """
    craft_dims = JOB_CRAFT_DIMS.get(job_type, [])
    stage_label = _STAGE_LABEL.get(stage, stage)
    sub_dims = SUBJECTIVE_DIMS.get(stage, [])

    craft_block = "\n".join(f"    - {d}" for d in craft_dims) if craft_dims else "    （本工种无 craft 维）"
    sub_block = (
        "本阶段可参考的主观维度（不进模型输出，仅供 owner 在主观通道赋分）：\n"
        + "\n".join(f"    - {d}" for d in sub_dims)
        if sub_dims
        else "本阶段无启用主观维度。"
    )

    return f"""{SYSTEM_PROMPT}

【当前评估上下文：{stage_label} · 工种={job_type}】
请按以下要求输出：
1) 六维 radar 照常输出（0–5，0.5 步进）。
2) craft 子对象：仅输出本工种下列专属维（0–5，0.5 步进），缺失则不填：
{craft_block}
3) 三条硬规则（已在上方「硬规则」中定义，此处重申必须严格执行）：
   - 声明–交付一致性（注水检测）：claim≠demo 必须降权并标注。
   - 跨模态自洽：多模态不得自相矛盾。
   - 可靠性：结论一致、可复核、不漂移降智。
4) {sub_block}
"""


def build_stage_messages(
    candidate: CandidateProfile,
    preference: UserPreference,
    job_type: str,
    stage: str,
) -> List[dict]:
    """
    构造「工种 × 阶段」评估消息列表（在 build_evaluation_messages 基础上
    使用 build_stage_system_prompt 的系统提示）。
    """
    user_text = (
        f"请评估候选：{candidate.name}（id={candidate.id}）。\n"
        f"自声明标签：{candidate.declared_tags}，声明预算：{candidate.declared_budget}。\n"
        f"文本 persona：\n{candidate.persona_text.content}\n\n"
        f"{_fmt_preference(preference)}\n\n"
        f"【工种={job_type} · 阶段={stage}】"
        f"（视频/语音/作品图/代码库已作为多模态输入提供，请跨模态交叉验证后输出 JSON。）"
    )
    return [
        {"role": "system", "content": build_stage_system_prompt(job_type, stage)},
        {"role": "user", "content": user_text},
    ]
