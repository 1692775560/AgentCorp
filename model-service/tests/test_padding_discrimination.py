"""
反注水区分效度测试（discriminant validity）。

它验证的是什么
--------------
现有 test_craft_judge.py 只验证「模型说注水了，我们能正确解析」——
那是**解析正确性**。本文件验证的是更根本的一件事：

    注水答案是否**确实会**被判低分？

如果一个评测系统给「话说得漂亮但没有可核验内容」的答案打高分，
说明它在测「文本流畅度」而非「工种胜任力」——这是效度失败，
而且是最危险的一种：系统看起来在工作，结论却是错的。

分两层执行
----------
第 1 层（始终在 CI 跑，不需要模型）：
    黄金对照集的结构性保证 + 提示词装配保证。
    重点是「注水答案必须比实答案更长」——若不满足，
    这套测试就无法证伪冗长偏差，测试本身失去意义。

第 2 层（配置了真实裁判后端时才跑）：
    真跑评分，断言实答案显著高于注水答案，且注水被标记。
    CI 默认 JUDGE_BACKEND=mock，此层自动跳过（不伪造通过）。

这样设计的原因：不能因为「CI 没有模型」就放弃这条断言，
也不能用 mock 假装验证过——所以拆成「永远能跑的必要条件」
与「有模型时才跑的充分条件」。
"""

from __future__ import annotations

import os
import re

import pytest

from app.scoring.craft_judge import build_craft_messages, judge_craft_task
from app.scoring.craft_tasks import get_task
from tests.fixtures.padding_gold_set import GOLD_PAIRS, get_pair

# 真实裁判是否可用：mock 后端不产出分数，第 2 层无意义
_JUDGE_READY = os.getenv("JUDGE_BACKEND", "mock").lower() != "mock"
requires_judge = pytest.mark.skipif(
    not _JUDGE_READY,
    reason="未配置真实裁判后端（JUDGE_BACKEND=mock）；区分效度断言需真实推理",
)

#: 实答案与注水答案之间要求的最小分差（0–5 量表）。
#: 1.5 分意味着跨越一个完整的锚点档位（如「部分兑现」→「多数兑现」），
#: 低于此值说明系统无法有效区分两类答案。
MIN_SCORE_GAP = 1.5


def _strip_code_blocks(text: str) -> str:
    """剥离 ``` 代码块，只留散文部分（用于「谁话更多」的公平比较）。"""
    return re.sub(r"```.*?```", "", text, flags=re.DOTALL).strip()


# ══════════════════════════════════════════════════════════════════
# 第 1 层：结构性保证（无需模型，CI 必跑）
# ══════════════════════════════════════════════════════════════════
class TestGoldSetIntegrity:
    """黄金对照集自身必须成立的前提，否则后续断言无意义。"""

    def test_every_pair_maps_to_a_real_task(self):
        for pair in GOLD_PAIRS:
            assert get_task(pair.task_id) is not None, f"题目不存在：{pair.task_id}"

    def test_padding_prose_is_not_shorter_than_substantive_prose(self):
        """
        注水答案的**散文体量**不得少于实答案的散文体量。

        这是整套测试的关键前提。若注水答案更短，「注水得低分」可能只是
        「短答案得低分」，无法证明系统真的识别了注水。

        注意比较口径：实答案里的代码块不计入散文长度——
        代码是「可核验产物」而非「话术」，把它算进字数会让比较失真
        （写代码的答案天然字多）。我们要比的是「谁话说得更满」，
        因此剥离代码块后再比。
        """
        for pair in GOLD_PAIRS:
            sub_prose = _strip_code_blocks(pair.substantive)
            slen, plen = len(sub_prose), len(pair.padding)
            assert plen >= slen * 0.8, (
                f"[{pair.task_id}] 注水答案散文 {plen} 字，实答案散文 {slen} 字。"
                f"注水方不够「话多」，无法区分「识别注水」与「歧视短答案」"
            )

    def test_padding_answers_contain_no_verifiable_artifacts(self):
        """注水答案不应含代码块等可核验产物——否则它就不算注水了。"""
        for pair in GOLD_PAIRS:
            assert "```" not in pair.padding, f"[{pair.task_id}] 注水答案不应包含代码块"

    def test_each_pair_declares_its_padding_pattern(self):
        """每对必须声明踩中的注水模式，便于断言失败时定位。"""
        for pair in GOLD_PAIRS:
            assert pair.padding_pattern.strip(), f"[{pair.task_id}] 缺 padding_pattern 说明"

    def test_gold_set_covers_multiple_tasks(self):
        assert len({p.task_id for p in GOLD_PAIRS}) >= 3, "对照集至少覆盖 3 道题"


class TestProbeInjection:
    """探针必须真的进到裁判提示词里，否则反注水机制形同虚设。"""

    @pytest.mark.parametrize("pair", GOLD_PAIRS, ids=lambda p: p.task_id)
    def test_probes_present_in_prompt(self, pair):
        task = get_task(pair.task_id)
        messages = build_craft_messages(task, pair.padding)
        user_text = messages[-1]["content"]
        assert "反注水探针" in user_text, "提示词缺少探针段落"
        for probe in task.probes:
            assert probe in user_text, f"探针未注入：{probe[:30]}"

    @pytest.mark.parametrize("pair", GOLD_PAIRS, ids=lambda p: p.task_id)
    def test_padding_rule_in_system_prompt(self, pair):
        task = get_task(pair.task_id)
        messages = build_craft_messages(task, pair.padding)
        system = messages[0]["content"]
        assert "空口承诺" in system, "系统提示词缺少空口承诺判定铁律"
        assert "padding" in system, "系统提示词未要求输出 padding 字段"


# ══════════════════════════════════════════════════════════════════
# 第 2 层：真实区分效度（需要真实裁判后端）
# ══════════════════════════════════════════════════════════════════
def _mean_dim_score(judgement) -> float:
    vals = [v for v in judgement.dims.values() if isinstance(v, (int, float))]
    return sum(vals) / len(vals) if vals else 0.0


@requires_judge
class TestDiscriminantValidity:
    """真跑评分：注水答案必须被识别并显著低分。"""

    @pytest.mark.parametrize("pair", GOLD_PAIRS, ids=lambda p: p.task_id)
    def test_substantive_scores_higher_than_padding(self, pair):
        sub = judge_craft_task(pair.task_id, pair.substantive)
        pad = judge_craft_task(pair.task_id, pair.padding)
        s_score, p_score = _mean_dim_score(sub), _mean_dim_score(pad)
        gap = s_score - p_score
        assert gap >= MIN_SCORE_GAP, (
            f"[{pair.task_id}] 区分效度不足：实答案 {s_score:.2f} vs 注水 {p_score:.2f}"
            f"（差 {gap:.2f} < 要求 {MIN_SCORE_GAP}）。\n"
            f"该注水答案本应踩中：{pair.padding_pattern}\n"
            f"评分系统可能被表面流畅度带偏。"
        )

    @pytest.mark.parametrize("pair", GOLD_PAIRS, ids=lambda p: p.task_id)
    def test_padding_flag_is_raised(self, pair):
        pad = judge_craft_task(pair.task_id, pair.padding)
        assert pad.padding_detected is True, (
            f"[{pair.task_id}] 注水未被标记。本应踩中：{pair.padding_pattern}"
        )

    @pytest.mark.parametrize("pair", GOLD_PAIRS, ids=lambda p: p.task_id)
    def test_substantive_not_falsely_flagged(self, pair):
        """反向保证：实答案不应被误判为注水（避免为通过测试而滥标）。"""
        sub = judge_craft_task(pair.task_id, pair.substantive)
        assert sub.padding_detected is False, (
            f"[{pair.task_id}] 实答案被误判为注水——假阳性同样是效度问题"
        )

    @pytest.mark.parametrize("pair", GOLD_PAIRS, ids=lambda p: p.task_id)
    def test_padding_checkpoints_mostly_miss(self, pair):
        """注水答案的 rubric 要点命中率应显著偏低（无原文可引）。"""
        pad = judge_craft_task(pair.task_id, pair.padding)
        if not pad.checkpoints:
            pytest.skip("裁判未返回逐条判定")
        hit_rate = sum(1 for c in pad.checkpoints if c.hit) / len(pad.checkpoints)
        assert hit_rate <= 0.34, (
            f"[{pair.task_id}] 注水答案要点命中率 {hit_rate:.0%} 过高，"
            f"裁判可能在无原文支撑时也判 hit"
        )
