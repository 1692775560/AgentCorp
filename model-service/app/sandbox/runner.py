"""
model-service/app/sandbox/runner.py
受限子进程执行器：把候选答案里的 Python 代码与测试真的跑一遍。

设计原则（每一条都对应一个「否则会骗自己」的失败模式）：

1. **只认退出码与断言，不认自然语言。** 产出的 verified_evidence 里写的是
   「4/4 用例通过」这类可核对的事实，而不是模型的复述。
2. **候选没写测试 = 无法验证，而不是验证不通过。** 两者结论完全不同：
   前者 outcome=no_tests（不解除降权、也不扣分），后者 outcome=failed（真实失败证据）。
   把「没考到」当成「考了但不好」是评测系统最常见的自欺。
3. **零新增依赖，不依赖 pytest。** 用自带 harness 收集 `test_*` 函数并逐个执行，
   因此在只装了 requirements.txt 的评测机上也能跑。
4. **失败必须可复现。** 退出码、stdout/stderr 截断片段、逐个用例结论全部回传。

安全边界（明确写出来，不假装是完整沙箱）：
  - 子进程 + `-I`（isolated：忽略用户 site-packages 与 PYTHON* 环境变量）；
  - cwd 为一次性临时目录，执行后整目录删除；
  - 墙钟超时强杀（kill 整个进程组）；
  - POSIX 上用 resource.setrlimit 限制 CPU 时间 / 地址空间 / 单文件大小 / 子进程数；
  - 环境变量白名单化（不透传 API key 等凭据）。
  **不提供网络隔离与文件系统隔离**：真正的多租户隔离需要容器/命名空间。
  因此默认只在本地评测场景启用，且 SANDBOX_ENABLED 默认关闭，需显式打开。
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..config import settings

logger = logging.getLogger("sandbox")

#: 执行结论。四态而非二态——「无法验证」与「验证不通过」必须区分。
SandboxOutcome = str  # 'passed' | 'failed' | 'no_tests' | 'no_code' | 'error' | 'disabled'

#: 从 markdown 代码块里抽 Python 源码
_PY_BLOCK_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)

#: harness：收集模块内的 test_* 函数逐个执行，输出机器可解析的结果行。
#: 单独成文件而不是 -c 内联，避免引号转义问题与超长命令行。
_HARNESS = '''
import importlib.util
import io
import sys
import traceback
import contextlib

SPEC = importlib.util.spec_from_file_location("candidate_answer", "answer.py")
MODULE = importlib.util.module_from_spec(SPEC)
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        SPEC.loader.exec_module(MODULE)
except BaseException:
    print("HARNESS_IMPORT_ERROR")
    traceback.print_exc(limit=5)
    sys.exit(3)

names = sorted(n for n in dir(MODULE) if n.startswith("test_") and callable(getattr(MODULE, n)))
if not names:
    print("HARNESS_NO_TESTS")
    sys.exit(4)

failed = 0
for name in names:
    fn = getattr(MODULE, name)
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            fn()
        print("CASE_PASS " + name)
    except BaseException as exc:
        failed += 1
        detail = "{}: {}".format(type(exc).__name__, exc)
        print("CASE_FAIL " + name + " :: " + detail.replace(chr(10), " ")[:200])

print("HARNESS_DONE total={} failed={}".format(len(names), failed))
sys.exit(0 if failed == 0 else 1)
'''


@dataclass
class SandboxResult:
    """一次真实执行的结果（全部字段都可被人工复核）。"""

    outcome: SandboxOutcome
    total: int = 0
    passed: int = 0
    failed: int = 0
    duration_ms: float = 0.0
    #: 逐个用例结论：[(用例名, 是否通过, 失败摘要)]
    cases: List[tuple] = field(default_factory=list)
    #: 子进程输出截断片段（便于人工排查，不参与打分）
    output_tail: str = ""
    #: outcome 为 error/disabled 时的原因
    reason: str = ""
    #: 实际执行的源码字节数（0 表示没抽到代码）
    code_bytes: int = 0

    @property
    def verifiable(self) -> bool:
        """本次执行是否产生了可采信的证据（只有真跑过用例才算）。"""
        return self.outcome in ("passed", "failed") and self.total > 0

    def evidence_text(self) -> str:
        """机器可核验证据文本（写进 StageScore.verifiedEvidence）。"""
        if self.outcome == "passed":
            return f"沙盒执行：{self.passed}/{self.total} 用例通过（{self.duration_ms:.0f}ms）"
        if self.outcome == "failed":
            first = next((c for c in self.cases if not c[1]), None)
            tail = f"；首个失败 {first[0]}：{first[2]}" if first else ""
            return (
                f"沙盒执行：{self.passed}/{self.total} 用例通过，"
                f"{self.failed} 个失败（{self.duration_ms:.0f}ms）{tail}"
            )
        return ""

    def to_dict(self) -> Dict:
        return {
            "outcome": self.outcome,
            "total": self.total,
            "passed": self.passed,
            "failed": self.failed,
            "durationMs": round(self.duration_ms, 1),
            "cases": [
                {"name": name, "passed": ok, "detail": detail} for name, ok, detail in self.cases
            ],
            "outputTail": self.output_tail,
            "reason": self.reason,
            "codeBytes": self.code_bytes,
            "verifiable": self.verifiable,
            "evidence": self.evidence_text(),
        }


def extract_python_blocks(answer: str) -> List[str]:
    """
    从候选答案里抽出 Python 代码块。

    优先取 ``` 围栏块；一个都没有时，若整段文本本身像代码（含 def/import/assert）
    则整体当作一个块——有些 agent 就是直接吐裸代码，不该因为少了三个反引号就判「无代码」。
    """
    text = answer or ""
    blocks = [b.strip() for b in _PY_BLOCK_RE.findall(text) if b.strip()]
    if blocks:
        return blocks
    stripped = text.strip()
    if not stripped:
        return []
    looks_like_code = bool(
        re.search(r"(^|\n)\s*(def |class |import |from \w+ import |assert )", stripped)
    )
    return [stripped] if looks_like_code else []


def _sandbox_env() -> Dict[str, str]:
    """环境变量白名单：绝不把 JUDGE_API_KEY 之类的凭据带进候选代码的进程。"""
    keep = ("PATH", "LANG", "LC_ALL", "TZ", "SYSTEMROOT", "TEMP", "TMP")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # 明确告诉候选代码「这里没有网络凭据」，顺便让依赖 requests 的代码更快失败
    env["NO_PROXY"] = "*"
    return env


def _preexec_limits(cpu_seconds: int, mem_mb: int):
    """POSIX 资源限制（Windows 上返回 None，由超时兜底）。"""
    if os.name != "posix":
        return None

    def _apply() -> None:  # pragma: no cover —— 子进程内执行，覆盖率统计不到
        import resource

        os.setsid()  # 独立进程组，超时能整组 kill
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        mem_bytes = mem_mb * 1024 * 1024
        try:
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        except (ValueError, OSError):
            pass  # 部分平台（如 macOS）不支持 RLIMIT_AS，退化为仅超时保护
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
        try:
            resource.setrlimit(resource.RLIMIT_NPROC, (64, 64))
        except (ValueError, OSError):
            pass

    return _apply


def _parse_harness_output(stdout: str) -> tuple:
    """解析 harness 输出 → (cases, total, failed, marker)。"""
    cases: List[tuple] = []
    total = 0
    failed = 0
    marker = ""
    for line in stdout.splitlines():
        line = line.strip()
        if line.startswith("CASE_PASS "):
            cases.append((line[len("CASE_PASS ") :].strip(), True, ""))
        elif line.startswith("CASE_FAIL "):
            body = line[len("CASE_FAIL ") :]
            name, _, detail = body.partition(" :: ")
            cases.append((name.strip(), False, detail.strip()))
        elif line.startswith("HARNESS_DONE"):
            marker = "done"
            m = re.search(r"total=(\d+) failed=(\d+)", line)
            if m:
                total, failed = int(m.group(1)), int(m.group(2))
        elif line.startswith("HARNESS_NO_TESTS"):
            marker = "no_tests"
        elif line.startswith("HARNESS_IMPORT_ERROR"):
            marker = "import_error"
    if total == 0:
        total = len(cases)
        failed = sum(1 for c in cases if not c[1])
    return cases, total, failed, marker


def run_python_answer(
    answer: str,
    *,
    timeout_s: Optional[float] = None,
    mem_mb: Optional[int] = None,
) -> SandboxResult:
    """
    在受限子进程里执行候选答案中的 Python 代码，并运行其中的 test_* 用例。

    返回 SandboxResult；**任何异常都被收敛为 outcome='error'**，
    绝不让沙盒的问题冒泡成评测失败（沙盒挂了是我们的问题，不是候选的问题）。
    """
    if not settings.sandbox_enabled:
        return SandboxResult(
            outcome="disabled",
            reason="沙盒未启用（设置 SANDBOX_ENABLED=true 开启真实执行验证）",
        )

    timeout = float(timeout_s if timeout_s is not None else settings.sandbox_timeout)
    memory = int(mem_mb if mem_mb is not None else settings.sandbox_mem_mb)

    blocks = extract_python_blocks(answer)
    if not blocks:
        return SandboxResult(outcome="no_code", reason="答案中未找到可执行的 Python 代码")

    source = "\n\n".join(blocks)
    workdir = tempfile.mkdtemp(prefix="agentcorp-sandbox-")
    started = 0.0
    try:
        import time

        with open(os.path.join(workdir, "answer.py"), "w", encoding="utf-8") as fh:
            fh.write(source)
        with open(os.path.join(workdir, "_harness.py"), "w", encoding="utf-8") as fh:
            fh.write(_HARNESS)

        started = time.perf_counter()
        try:
            proc = subprocess.run(
                [sys.executable, "-I", "-B", "_harness.py"],
                cwd=workdir,
                env=_sandbox_env(),
                capture_output=True,
                text=True,
                timeout=timeout,
                preexec_fn=_preexec_limits(int(timeout) + 1, memory),  # noqa: PLW1509
                check=False,
            )
        except subprocess.TimeoutExpired:
            return SandboxResult(
                outcome="failed",
                total=1,
                passed=0,
                failed=1,
                duration_ms=timeout * 1000.0,
                cases=[("<timeout>", False, f"执行超过 {timeout:.0f}s 未结束（疑似死循环/阻塞）")],
                reason="timeout",
                code_bytes=len(source.encode("utf-8")),
            )

        duration_ms = (time.perf_counter() - started) * 1000.0
        combined = f"{proc.stdout}\n{proc.stderr}".strip()
        cases, total, failed, marker = _parse_harness_output(proc.stdout)

        if marker == "no_tests":
            return SandboxResult(
                outcome="no_tests",
                duration_ms=duration_ms,
                output_tail=combined[-1200:],
                reason="代码可导入，但未提供 test_* 用例，无法真实验证",
                code_bytes=len(source.encode("utf-8")),
            )
        if marker == "import_error":
            return SandboxResult(
                outcome="failed",
                total=1,
                passed=0,
                failed=1,
                duration_ms=duration_ms,
                cases=[("<import>", False, "代码无法导入（语法错误 / 未定义名称 / 缺依赖）")],
                output_tail=combined[-1200:],
                code_bytes=len(source.encode("utf-8")),
            )
        if total == 0:
            return SandboxResult(
                outcome="error",
                duration_ms=duration_ms,
                output_tail=combined[-1200:],
                reason=f"harness 未产出可解析结果（exit={proc.returncode}）",
                code_bytes=len(source.encode("utf-8")),
            )

        return SandboxResult(
            outcome="passed" if failed == 0 else "failed",
            total=total,
            passed=total - failed,
            failed=failed,
            duration_ms=duration_ms,
            cases=cases,
            output_tail=combined[-1200:],
            code_bytes=len(source.encode("utf-8")),
        )
    except Exception as exc:  # noqa: BLE001 —— 沙盒自身故障不得冒泡为评测失败
        logger.warning("沙盒执行异常：%s", exc)
        return SandboxResult(outcome="error", reason=f"沙盒执行异常：{exc}")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def verified_evidence_for(task_id: str, result: SandboxResult) -> Dict[str, str]:
    """
    把执行结果映射为 requiresReal 维的 verified_evidence。

    只有 verifiable（真跑过用例）才产出条目：
    - 通过/失败都算「已验证」，因为两者都是关于可运行性的**事实**；
    - no_tests / no_code / error / disabled 一律不产出 —— 缺证据就该继续降权，
      这正是 Q6 闸门存在的意义。

    `code_security` 不由本模块产出：跑通测试不等于扫过安全，
    那需要真实的静态扫描接入（路线图），此处宁缺毋滥。
    """
    if not result.verifiable:
        return {}
    return {"code_runnability": f"[{task_id}] {result.evidence_text()}"}
