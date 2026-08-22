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

    def test_sandbox_declared_dims_empty(self):
        """sandbox 不产分数，declared_dims 为空列表。"""
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        ev = SandboxEvaluator()
        assert ev.declared_dims == []

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


# ======================================================================
# 6. 遥测
# ======================================================================
class TestTelemetry:
    """dispatch 后 stats() 应反映调用次数和错误数。"""

    def test_stats_after_dispatch(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())

        # 跑一次 dispatch（空答案 → confidence=0 但不算 error）
        reg.dispatch("sandbox", EvaluatorInput(
            agent_id="x", job_type="code", answer="",
        ))
        st = reg.stats()
        assert "sandbox" in st
        assert st["sandbox"]["calls"] == 1
        assert st["sandbox"]["errors"] == 0
        assert st["sandbox"]["totalMs"] >= 0

    def test_stats_error_counted(self):
        """派发不存在的 evaluator → KeyError，stats 不更新（get 阶段就失败）。"""
        reg = JudgeRegistry()
        with pytest.raises(KeyError):
            reg.dispatch("nonexistent", EvaluatorInput(agent_id="x", job_type="code"))
        # 不存在的 evaluator 不应出现在 stats 中
        assert "nonexistent" not in reg.stats()

    def test_stats_avg_ms(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        for _ in range(3):
            reg.dispatch("sandbox", EvaluatorInput(
                agent_id="x", job_type="code", answer="",
            ))
        st = reg.stats()["sandbox"]
        assert st["calls"] == 3
        assert st["avgMs"] >= 0


# ======================================================================
# 7. 异步派发
# ======================================================================
class TestAsyncDispatch:
    """dispatch_async 能处理同步 Evaluator（run_in_executor 包装）。"""

    @pytest.mark.anyio
    async def test_dispatch_async_sync_evaluator(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        out = await reg.dispatch_async("sandbox", EvaluatorInput(
            agent_id="x", job_type="code", answer="",
        ))
        assert out.evaluator_id == "sandbox"
        # 异步派发也应记录遥测
        st = reg.stats()["sandbox"]
        assert st["calls"] == 1

    @pytest.mark.anyio
    async def test_dispatch_async_wrong_job_raises(self):
        reg = JudgeRegistry()
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        reg.register(SandboxEvaluator())
        with pytest.raises(ValueError, match="不适用于工种"):
            await reg.dispatch_async("sandbox", EvaluatorInput(
                agent_id="x", job_type="text",
            ))


# ======================================================================
# 8. declared_dims 静态校验
# ======================================================================
class TestDeclaredDims:
    """declared_dims 在注册时校验 ⊆ registry 允许集。"""

    def test_sandbox_declared_empty(self):
        from app.scoring.evaluators.sandbox_evaluator import SandboxEvaluator
        assert SandboxEvaluator.declared_dims == []

    def test_growth_declared_dims(self):
        from app.scoring.evaluators.growth_evaluator import GrowthEvaluator
        from app.scoring.registry import RADAR_DIMS
        declared = set(GrowthEvaluator.declared_dims)
        # 通用六维（纵向追踪）；overall 是汇总指标，不参与维度校验
        assert declared == set(RADAR_DIMS)

    def test_enterprise_fit_declared_dims(self):
        from app.scoring.evaluators.enterprise_fit_evaluator import EnterpriseFitEvaluator
        from app.scoring.registry import RADAR_DIMS, JOB_CRAFT_DIMS
        declared = set(EnterpriseFitEvaluator.declared_dims)
        assert set(RADAR_DIMS).issubset(declared)
        all_craft = {d for dims in JOB_CRAFT_DIMS.values() for d in dims}
        assert all_craft.issubset(declared)

    def test_craft_judge_declared_dims(self):
        from app.scoring.craft_judge import CraftJudgeEvaluator
        from app.scoring.registry import JOB_CRAFT_DIMS
        declared = set(CraftJudgeEvaluator.declared_dims)
        all_craft = {d for dims in JOB_CRAFT_DIMS.values() for d in dims}
        assert all_craft.issubset(declared)

    def test_arena_judge_no_declared_dims(self):
        """arena_judge 产出含 fit（非 registry 维），跳过静态校验。"""
        from app.scoring.arena_judge import ArenaJudgeEvaluator
        assert not hasattr(ArenaJudgeEvaluator, "declared_dims")
