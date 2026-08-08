"""
model-service/tests/test_craft_judge.py

工种试做题库与 craft LLM-as-judge 解析的单测。

覆盖三件事：
1. 题库自洽 —— 维度键必须属于 registry.JOB_CRAFT_DIMS，rubric 不为空
2. 输出解析 —— 越界维度丢弃、无 quote 的 hit 降级、非法 JSON 报错
3. 聚合 —— 未覆盖维度进入 unscored 而不是补默认分
4. 参考答案锚定（B：天花板缓解）与公开题库安全

运行：python -m pytest tests/test_craft_judge.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.scoring.craft_judge import (  # noqa: E402
    CraftJudgement,
    aggregate_craft_dims,
    build_craft_messages,
    parse_craft_output,
)
from app.scoring.craft_tasks import (  # noqa: E402
    all_task_ids,
    covered_dims,
    get_task,
    tasks_for,
    uncovered_dims,
)
from app.scoring.registry import JOB_CRAFT_DIMS  # noqa: E402

JOB_TYPES = ["code", "text", "image"]


# ----------------------------------------------------------------------
# 1) 题库自洽性
# ----------------------------------------------------------------------
def test_every_job_type_has_tasks():
    for job in JOB_TYPES:
        assert tasks_for(job), f"{job} 工种没有试做题，该工种无法客观评测"


def test_task_ids_are_unique():
    ids = all_task_ids()
    assert len(ids) == len(set(ids)), "题目 id 重复会让评分结果互相覆盖"


def test_target_dims_belong_to_registry():
    for job in JOB_TYPES:
        allowed = set(JOB_CRAFT_DIMS[job])
        for task in tasks_for(job):
            unknown = set(task.target_dims) - allowed
            assert not unknown, f"题 {task.id} 引用了不属于 {job} 的维度：{unknown}"


def test_tasks_carry_rubric_and_probes():
    for job in JOB_TYPES:
        for task in tasks_for(job):
            assert task.checkpoints, f"题 {task.id} 缺 rubric，裁判只能凭感觉打分"
            assert task.probes, f"题 {task.id} 缺反注水探针"
            assert task.target_dims, f"题 {task.id} 未声明考查维度"


def test_covered_and_uncovered_dims_partition():
    """覆盖 + 未覆盖必须正好等于该工种全部维度，不重不漏。"""
    for job in JOB_TYPES:
        assert sorted(covered_dims(job) + uncovered_dims(job)) == sorted(
            JOB_CRAFT_DIMS[job]
        )


# ----------------------------------------------------------------------
# 2) 提示词构造
# ----------------------------------------------------------------------
def test_build_messages_contains_rubric_and_answer():
    task = get_task("code_csv_merge")
    messages = build_craft_messages(task, "我的答案：def merge_orders(): ...")

    assert messages[0]["role"] == "system"
    user_text = messages[1]["content"]
    assert task.prompt in user_text, "题面必须原样进入提示词，保证同题可复现"
    for cp in task.checkpoints:
        assert cp in user_text, "rubric 每条都要交给裁判"
    assert "merge_orders" in user_text
    for dim in task.target_dims:
        assert dim in user_text, "必须限定 dims 可用键，防止裁判自行扩维"


def test_build_messages_marks_empty_answer():
    task = get_task("text_compress")
    user_text = build_craft_messages(task, "   ")[1]["content"]
    assert "未作答" in user_text, "空答案要显式告知裁判，而不是留白让它猜"


# ----------------------------------------------------------------------
# 3) 输出解析
# ----------------------------------------------------------------------
def test_parse_normal_output():
    task = get_task("text_compress")
    raw = """```json
{
  "dims": {"txt_info_density": 4.0, "txt_coherence": 3.5},
  "checkpoints": [
    {"checkpoint": "压缩结果不超过 40 字（可直接核验）", "hit": true, "quote": "帮职场人客观评测"}
  ],
  "padding": {"detected": false, "note": ""},
  "confidence": 0.82
}
```"""
    result = parse_craft_output(raw, task)

    assert result.dims == {"txt_info_density": 4.0, "txt_coherence": 3.5}
    assert result.checkpoints[0].hit is True
    assert result.confidence == 0.82
    assert result.padding_detected is False


def test_parse_drops_out_of_scope_dims():
    """裁判自行扩维必须被丢弃，否则工种维度体系会被污染。"""
    task = get_task("text_compress")
    raw = '{"dims": {"txt_info_density": 4.0, "code_security": 5.0}, "confidence": 0.5}'
    result = parse_craft_output(raw, task)

    assert "code_security" not in result.dims
    assert result.dims == {"txt_info_density": 4.0}


def test_parse_demotes_hit_without_quote():
    """铁律：无原文支撑的 hit 一律降为 miss，避免裁判空口判过。"""
    task = get_task("code_csv_merge")
    raw = """{"dims": {}, "checkpoints": [
        {"checkpoint": "金额解析处理了千分位", "hit": true, "quote": ""},
        {"checkpoint": "代码可直接运行", "hit": true, "quote": "def merge_orders(a, b):"}
    ], "confidence": 0.6}"""
    result = parse_craft_output(raw, task)

    assert result.checkpoints[0].hit is False, "无 quote 的 hit 应降为 miss"
    assert result.checkpoints[1].hit is True


def test_parse_records_unscored_dims():
    """裁判漏评的维度进入 unscored_dims，不补默认分。"""
    task = get_task("code_csv_merge")
    result = parse_craft_output('{"dims": {"code_runnability": 4.0}}', task)

    assert result.dims == {"code_runnability": 4.0}
    assert set(result.unscored_dims) == set(task.target_dims) - {"code_runnability"}


def test_parse_clamps_and_aligns_half_step():
    task = get_task("code_csv_merge")
    raw = '{"dims": {"code_runnability": 9.9, "code_test_coverage": -3, "code_maintainability": 3.3}}'
    result = parse_craft_output(raw, task)

    assert result.dims["code_runnability"] == 5.0
    assert result.dims["code_test_coverage"] == 0.0
    assert result.dims["code_maintainability"] == 3.5


def test_parse_tolerates_surrounding_prose():
    task = get_task("text_compress")
    raw = '好的，我的评分如下：\n{"dims": {"txt_coherence": 3.0}}\n以上。'
    assert parse_craft_output(raw, task).dims == {"txt_coherence": 3.0}


def test_parse_rejects_non_json():
    task = get_task("text_compress")
    with pytest.raises(ValueError):
        parse_craft_output("这个候选写得挺好的，我给 4 分。", task)


def test_parse_detects_padding():
    task = get_task("code_csv_merge")
    raw = '{"dims": {}, "padding": {"detected": true, "note": "声称已充分测试但无用例"}}'
    result = parse_craft_output(raw, task)

    assert result.padding_detected is True
    assert "充分测试" in result.padding_note


# ----------------------------------------------------------------------
# 4) 多题聚合
# ----------------------------------------------------------------------
def test_aggregate_averages_duplicate_dims():
    j1 = CraftJudgement(task_id="a", job_type="code", dims={"code_runnability": 4.0})
    j2 = CraftJudgement(task_id="b", job_type="code", dims={"code_runnability": 3.0})
    dims, _ = aggregate_craft_dims([j1, j2], "code")

    assert dims["code_runnability"] == 3.5


def test_aggregate_reports_unscored_instead_of_zero():
    j = CraftJudgement(task_id="a", job_type="code", dims={"code_security": 4.0})
    dims, unscored = aggregate_craft_dims([j], "code")

    assert dims == {"code_security": 4.0}
    assert "code_runnability" in unscored
    assert all(d not in dims for d in unscored), "未评维度不得出现在分数里"


def test_aggregate_empty_input():
    dims, unscored = aggregate_craft_dims([], "image")
    assert dims == {}
    assert set(unscored) == set(JOB_CRAFT_DIMS["image"])


# ----------------------------------------------------------------------
# 5) 参考答案锚定（B：天花板缓解）与公开题库安全
# ----------------------------------------------------------------------
def test_all_tasks_have_reference_answer():
    """每道题都必须有参考答案，否则该题退回绝对尺度、存在天花板压缩。"""
    from app.scoring.craft_tasks import get_reference

    for task_id in all_task_ids():
        assert get_reference(task_id).strip(), f"题 {task_id} 缺参考答案"

    assert "code_boss_system" in all_task_ids(), "压轴题必须入库（难度标定）"
    assert "text_boss_rewrite" in all_task_ids()
    assert "image_boss_system" in all_task_ids()


def test_build_messages_embeds_reference():
    from app.scoring.craft_tasks import get_reference

    task = get_task("code_boss_system")
    user_text = build_craft_messages(task, "答案")[1]["content"]
    ref = get_reference(task.id)

    assert ref in user_text, "参考答案必须进入裁判提示词（相对锚定）"
    assert "满分基准" in user_text


def test_public_task_list_never_exposes_reference():
    """公开题库接口的安全边界：参考答案只进裁判 prompt，绝不出现在题面。"""
    from app.scoring.craft_tasks import get_reference

    for task in [get_task(tid) for tid in all_task_ids()]:
        assert task is not None
        for line in get_reference(task.id).splitlines():
            assert line.strip() not in task.prompt, f"题 {task.id} 的题面泄露了参考答案"
            assert line.strip() not in " ".join(task.checkpoints), (
                f"题 {task.id} 的 rubric 泄露了参考答案"
            )
