"""
model-service/app/sandbox
候选代码的真实执行验证（把「模型说这段代码能跑」变成「这段代码真的跑过了」）。

为什么必须有这一层：`code_runnability` / `code_security` 在注册表里被标为
requiresReal（registry.CRAFT_REQUIRES_REAL），缺真实证据时 stage_scorer 会把该维
权重 ×0.4。此前唯一能填进 verified_evidence 的东西是裁判模型自己的引文 ——
等于让被监管方给自己发合格证。本模块提供真正的机器可核验证据：
在受限子进程里跑候选给出的代码与测试，用退出码与断言结果说话。
"""
from .runner import (  # noqa: F401
    SandboxOutcome,
    SandboxResult,
    extract_python_blocks,
    run_python_answer,
    verified_evidence_for,
)
from .security_scan import (  # noqa: F401
    SecurityFinding,
    SecurityScanResult,
    scan_python_answer,
    scan_source_ast,
    security_evidence_for,
)

__all__ = [
    "SandboxOutcome",
    "SandboxResult",
    "extract_python_blocks",
    "run_python_answer",
    "verified_evidence_for",
    "SecurityFinding",
    "SecurityScanResult",
    "scan_python_answer",
    "scan_source_ast",
    "security_evidence_for",
]
