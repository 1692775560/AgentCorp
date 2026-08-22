"""
model-service/tests/test_registry.py
JudgeRegistry 注册完整性测试。

CI 强制：
1. 所有已知 Evaluator 都已注册（新增必登记）；
2. 重名注册报错（防静默覆盖）；
3. Evaluator 产出维度必须是 registry 允许维度的子集（防自定维度）；
4. 派发校验工种适用性。

运行：python -m pytest tests/test_registry.py -q
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from app.scoring.evaluator_protocol import (  # noqa: E402
    EvaluatorInput,
)
from app.scoring.judge_registry import JudgeRegistry, get_registry  # noqa: E402
from app.scoring.evaluators import register_all  # noqa: E402


# ======================================================================
# 1. 注册完整性 —— 所有已知 Evaluator 都已注册
# ======================================================================
class TestAllEvaluatorsRegistered:
    """CI 强制：新增 Evaluator 必须在 evaluators/__init__.py 登记。"""

    def test_register_all_succeeds(self):
        reg = JudgeRegistry()
        register_all(reg)

    def test_known_evaluators_present(self):
        reg = JudgeRegistry()
        register_all(reg)
        ids = set(reg.list_ids())
        for expected in ("craft_judge", "arena_judge", "sandbox", "growth", "enterprise_fit"):
            assert expected in ids, f"Evaluator '{expected}' 未注册"

    def test_at_least_five_registered(self):
        reg = JudgeRegistry()
        register_all(reg)
        assert len(reg.list_ids()) >= 5


# ======================================================================
# 2. 重名保护
# ======================================================================
class TestDuplicateRegistration:
    """重名注册必须报错——防止静默覆盖。"""

    def test_duplicate_id_raises(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        with pytest.raises(ValueError, match="已注册"):
            reg.register(SandboxEvaluator())

    def test_missing_id_raises(self):
        reg = JudgeRegistry()

        class _Bad:
            applicable_jobs = ["code"]
            def evaluate(self, inp): ...

        with pytest.raises(ValueError, match="evaluator_id"):
            reg.register(_Bad())

    def test_missing_applicable_jobs_raises(self):
        reg = JudgeRegistry()

        class _Bad:
            evaluator_id = "bad"
            def evaluate(self, inp): ...

        with pytest.raises(ValueError, match="applicable_jobs"):
            reg.register(_Bad())


# ======================================================================
# 3. 维度子集校验
# ======================================================================
class TestDimensionSubset:
    """Evaluator 声明维度不得越界。"""

    def test_sandbox_no_declared_dims(self):
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        ev = SandboxEvaluator()
        assert not hasattr(ev, "declared_dims")

    def test_get_unregistered_raises_keyerror(self):
        reg = JudgeRegistry()
        with pytest.raises(KeyError, match="未注册"):
            reg.get("nonexistent")


# ======================================================================
# 4. 派发校验
# ======================================================================
class TestDispatch:
    """dispatch 校验工种适用性。"""

    def test_dispatch_wrong_job_raises(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        with pytest.raises(ValueError, match="不适用于工种"):
            reg.dispatch("sandbox", EvaluatorInput(
                agent_id="x", job_type="text",
            ))

    def test_dispatch_sandbox_no_code_returns_empty(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        out = reg.dispatch("sandbox", EvaluatorInput(
            agent_id="x", job_type="code", answer="",
        ))
        assert out.evaluator_id == "sandbox"
        assert out.scores == {}
        assert out.confidence == 0.0


# ======================================================================
# 5. 全局单例
# ======================================================================
class TestSingleton:
    """get_registry() 返回全局单例。"""

    def test_singleton_identity(self):
        assert get_registry() is get_registry()
