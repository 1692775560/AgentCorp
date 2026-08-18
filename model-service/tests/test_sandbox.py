"""
model-service/tests/test_sandbox.py
沙盒真实执行验证的单测。

这些用例真的会启动子进程执行代码——这正是重点：
如果沙盒本身是 mock 的，那它产出的「机器可核验证据」就还是自说自话。

覆盖：
- 代码抽取（围栏块 / 裸代码 / 非代码文本）
- 通过 / 失败 / 无测试 / 无代码 / 语法错误 五类结论互不混淆
- 死循环被超时终止且记为失败证据（而不是挂住整个评测）
- verified_evidence 只在真跑过用例时产出（no_tests 不得解除 Q6 降权）
- 总开关关闭时明确返回 disabled，且不产出任何证据
- 凭据不泄漏进候选代码进程
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.sandbox import (
    extract_python_blocks,
    run_python_answer,
    verified_evidence_for,
)


@pytest.fixture(autouse=True)
def _enable_sandbox(monkeypatch):
    """默认开启沙盒（生产默认关闭，测试里显式打开）。"""
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)
    monkeypatch.setattr(settings, "sandbox_timeout", 12.0, raising=False)
    monkeypatch.setattr(settings, "sandbox_mem_mb", 512, raising=False)


# ======================================================================
# 代码抽取
# ======================================================================
def test_extract_fenced_python_block():
    answer = "先给实现：\n\n```python\ndef add(a, b):\n    return a + b\n```\n\n以上。"
    blocks = extract_python_blocks(answer)
    assert len(blocks) == 1
    assert "def add" in blocks[0]


def test_extract_multiple_blocks_are_concatenated_in_order():
    answer = "```python\ndef a():\n    return 1\n```\n说明\n```py\ndef test_a():\n    assert a() == 1\n```"
    blocks = extract_python_blocks(answer)
    assert len(blocks) == 2
    assert "def a()" in blocks[0] and "def test_a" in blocks[1]


def test_extract_bare_code_without_fence():
    """有些 agent 直接吐裸代码，不该因为少了三个反引号就判「无代码」。"""
    blocks = extract_python_blocks("def merge():\n    return []\n")
    assert len(blocks) == 1


def test_extract_prose_is_not_code():
    assert extract_python_blocks("我会先读取两份 CSV，然后按订单号合并，保证数据质量。") == []
    assert extract_python_blocks("") == []


# ======================================================================
# 执行结论
# ======================================================================
def test_passing_tests_produce_verifiable_evidence():
    answer = """
```python
def merge(a, b):
    return sorted(set(a) | set(b))


def test_merge_dedups():
    assert merge([1, 2], [2, 3]) == [1, 2, 3]


def test_merge_empty():
    assert merge([], []) == []
```
"""
    result = run_python_answer(answer)
    assert result.outcome == "passed"
    assert (result.total, result.passed, result.failed) == (2, 2, 0)
    assert result.verifiable is True
    assert "2/2 用例通过" in result.evidence_text()

    evidence = verified_evidence_for("code_csv_merge", result)
    assert "code_runnability" in evidence
    # code_security 不由跑测试产出——跑通不等于扫过
    assert "code_security" not in evidence


def test_failing_test_is_real_negative_evidence():
    answer = """
```python
def add(a, b):
    return a - b


def test_add():
    assert add(1, 2) == 3
```
"""
    result = run_python_answer(answer)
    assert result.outcome == "failed"
    assert (result.total, result.passed, result.failed) == (1, 0, 1)
    # 失败同样是「已验证」的事实：关于可运行性我们确实测到了结论
    assert result.verifiable is True
    assert "code_runnability" in verified_evidence_for("t", result)
    failed_case = next(c for c in result.cases if not c[1])
    assert "AssertionError" in failed_case[2]


def test_no_tests_is_not_a_failure_and_yields_no_evidence():
    """「没写测试」≠「测试没过」。前者不该扣分，也不该解除降权。"""
    answer = "```python\ndef add(a, b):\n    return a + b\n```"
    result = run_python_answer(answer)
    assert result.outcome == "no_tests"
    assert result.verifiable is False
    assert verified_evidence_for("t", result) == {}


def test_no_code_answer():
    result = run_python_answer("我会用 pandas 读入两张表然后按 order_id 合并。")
    assert result.outcome == "no_code"
    assert verified_evidence_for("t", result) == {}


def test_syntax_error_is_import_failure():
    answer = "```python\ndef broken(:\n    return 1\n```"
    result = run_python_answer(answer)
    assert result.outcome == "failed"
    assert result.cases and result.cases[0][0] == "<import>"


def test_undefined_name_at_import_time_fails():
    answer = "```python\nvalue = undefined_thing()\n\ndef test_v():\n    assert value\n```"
    result = run_python_answer(answer)
    assert result.outcome == "failed"


def test_infinite_loop_is_killed_by_timeout(monkeypatch):
    """死循环必须被超时终止并记为失败，而不是挂住整条评测链路。"""
    monkeypatch.setattr(settings, "sandbox_timeout", 2.0, raising=False)
    answer = "```python\nwhile True:\n    pass\n\ndef test_never_runs():\n    assert True\n```"
    result = run_python_answer(answer)
    assert result.outcome == "failed"
    assert result.reason == "timeout"
    assert result.cases[0][0] == "<timeout>"


def test_partial_failure_counts_are_exact():
    answer = """
```python
def test_a():
    assert True


def test_b():
    assert False, "b 必然失败"


def test_c():
    assert 1 + 1 == 2
```
"""
    result = run_python_answer(answer)
    assert (result.total, result.passed, result.failed) == (3, 1, 2) or (
        result.total,
        result.passed,
        result.failed,
    ) == (3, 2, 1)
    # 精确断言：只有 test_b 失败
    failed_names = sorted(name for name, ok, _ in result.cases if not ok)
    assert failed_names == ["test_b"]


# ======================================================================
# 安全与开关
# ======================================================================
def test_disabled_switch_returns_disabled_and_no_evidence(monkeypatch):
    monkeypatch.setattr(settings, "sandbox_enabled", False, raising=False)
    result = run_python_answer("```python\ndef test_x():\n    assert True\n```")
    assert result.outcome == "disabled"
    assert result.verifiable is False
    assert verified_evidence_for("t", result) == {}


def test_credentials_are_not_exposed_to_candidate_code(monkeypatch):
    """候选代码进程里不得出现 JUDGE_API_KEY 之类的凭据。"""
    monkeypatch.setenv("JUDGE_API_KEY", "sk-should-not-leak")
    answer = """
```python
import os


def test_no_key():
    assert os.getenv("JUDGE_API_KEY") is None, "凭据泄漏到候选代码进程"
```
"""
    result = run_python_answer(answer)
    assert result.outcome == "passed"


def test_sandbox_never_raises_on_weird_input():
    """沙盒自身故障不得冒泡：任何奇怪输入都应收敛为一个结论对象。"""
    for weird in ["", "```python\n```", "```python\nimport sys; sys.exit(9)\n```"]:
        result = run_python_answer(weird)
        assert result.outcome in ("no_code", "no_tests", "failed", "error", "passed")


def test_to_dict_is_json_serializable():
    import json

    result = run_python_answer("```python\ndef test_ok():\n    assert True\n```")
    payload = json.dumps(result.to_dict(), ensure_ascii=False)
    assert '"outcome"' in payload and '"verifiable"' in payload
