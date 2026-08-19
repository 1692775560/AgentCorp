"""
model-service/tests/test_security_scan.py
静态安全扫描的单测。

守的核心命题：**功能正确 ≠ 安全**。
一段 eval(user_input) 可以通过所有单元测试，因此 code_security 必须有
一条与「跑测试」完全独立的证据链。这些用例逐条钉死规则表的行为，
保证「已扫描」不是一句注释。
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.sandbox import (
    scan_python_answer,
    scan_source_ast,
    security_evidence_for,
)


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    monkeypatch.setattr(settings, "sandbox_enabled", True, raising=False)


def rules(src: str):
    return {f.rule for f in scan_source_ast(src).findings}


def test_eval_and_exec_are_high_severity():
    result = scan_source_ast("def f(s):\n    return eval(s)\n")
    assert result.outcome == "scanned"
    assert result.high == 1
    assert result.findings[0].rule == "dangerous-call:eval"
    assert result.findings[0].line == 2


def test_os_system_command_injection():
    assert "dangerous-call:os.system" in rules("import os\nos.system('ls ' + name)\n")


def test_subprocess_shell_true_flagged_but_shell_false_is_clean():
    assert "subprocess-shell-true" in rules(
        "import subprocess\nsubprocess.run(cmd, shell=True)\n"
    )
    # shell=False 是推荐写法，不该误报——误报会让扫描结论失去可信度
    assert "subprocess-shell-true" not in rules(
        "import subprocess\nsubprocess.run(['ls', '-l'], shell=False)\n"
    )
    assert "subprocess-shell-true" not in rules("import subprocess\nsubprocess.run(['ls'])\n")


def test_pickle_and_yaml_deserialization():
    assert "dangerous-call:pickle.loads" in rules("import pickle\npickle.loads(blob)\n")
    assert "dangerous-call:yaml.load" in rules("import yaml\nyaml.load(text)\n")


def test_tls_verify_disabled():
    assert "tls-verify-disabled" in rules("import requests\nrequests.get(url, verify=False)\n")


def test_hardcoded_secret():
    assert "hardcoded-secret" in rules('api_key = "sk-1234567890"\n')
    # 从环境变量读取是正确姿势，不得误报
    assert "hardcoded-secret" not in rules('import os\napi_key = os.getenv("API_KEY")\n')


def test_path_traversal_hint_on_variable_join():
    assert "path-join-unnormalized" in rules("import os\np = os.path.join(base, user_input)\n")
    # 全常量拼接没有穿越风险
    assert "path-join-unnormalized" not in rules("import os\np = os.path.join('a', 'b')\n")


def test_silent_except_is_low_severity():
    result = scan_source_ast("try:\n    risky()\nexcept Exception:\n    pass\n")
    assert [f.rule for f in result.findings] == ["silent-except"]
    assert result.high == 0


def test_clean_code_yields_zero_findings_but_still_counts_as_scanned():
    result = scan_source_ast("def add(a, b):\n    return a + b\n")
    assert result.outcome == "scanned"
    assert result.findings == []
    # 「零发现」也是证据：记录的是「扫过、没扫出高危」这个事实
    assert "0 处高危" in result.evidence_text()
    assert security_evidence_for("t", result) != {}


def test_findings_sorted_by_severity():
    src = "try:\n    pass\nexcept Exception:\n    pass\n\nresult = eval(x)\n"
    result = scan_source_ast(src)
    assert result.findings[0].severity == "high"


def test_syntax_error_gives_no_security_conclusion():
    """代码都解析不了，就不该冒充扫过——宁缺毋滥。"""
    result = scan_source_ast("def broken(:\n    pass\n")
    assert result.outcome == "syntax_error"
    assert result.verifiable is False
    assert security_evidence_for("t", result) == {}


def test_no_code_and_disabled_produce_no_evidence(monkeypatch):
    assert scan_python_answer("我会注意安全问题，做好鉴权和限流。").outcome == "no_code"
    monkeypatch.setattr(settings, "sandbox_enabled", False, raising=False)
    assert scan_python_answer("```python\nx = 1\n```").outcome == "disabled"


def test_scan_and_run_see_the_same_code():
    """扫的和跑的必须是同一段代码，否则两条证据链对不上号。"""
    answer = "```python\nimport os\n\ndef test_ok():\n    assert True\n\nos.system('echo hi')\n```"
    scan = scan_python_answer(answer)
    assert scan.outcome == "scanned"
    assert scan.high >= 1


def test_evidence_text_is_human_checkable():
    result = scan_source_ast("x = eval(s)\n")
    text = result.evidence_text()
    assert "静态扫描" in text and "高危" in text and "L1" in text
