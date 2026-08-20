"""
model-service/app/sandbox/craft_tasks_sandbox.py
craft 题的沙箱可验版本：为每道可机验的 craft 题定义 fixture + test harness。

为什么需要它：craft_tasks.py 只有题面和 rubric（文本），评分全靠 LLM 读散文。
本模块为可机验的题目补充「固定 fixture + 断言脚本」，让 harness 真跑代码、
真验结果，产出 machine_verified 证据。

接入方式：sandbox runner 拿到候选代码后，从本模块取该题的 SandboxSpec，
把 fixture 和 test_harness 写入沙箱目录，执行后得到 SandboxResult。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class SandboxSpec:
    """一道题的沙箱可验规格。"""
    task_id: str
    #: fixture 文件 {filename: content} —— 写入沙箱目录
    fixture_files: Dict[str, str] = field(default_factory=dict)
    #: 测试执行脚本（断言逻辑）—— 沙箱中用 python 运行
    test_harness: str = ""
    #: 该题可机验的 craft 维度（断言通过即 machine_verified）
    machine_verifiable_dims: List[str] = field(default_factory=list)


# ======================================================================
# code_csv_merge —— 合并 CSV 并处理脏数据（可机验）
# ======================================================================
_CSV_MERGE_FIXTURE_A = """order_id,amount,updated_at
1001,"1,234.50",2024-01-15T10:00:00
1002,"￥88",2024-01-15T11:00:00
1003,,2024-01-15T12:00:00
"""

_CSV_MERGE_FIXTURE_B = """order_id,amount,updated_at
1001,"999.00",2024-01-15T09:00:00
1002,"￥88",2024-01-14T08:00:00
1004,"abc",2024-01-15T13:00:00
"""

_CSV_MERGE_TEST_HARNESS = '''\
"""code_csv_merge 自动断言脚本。沙箱执行入口。"""
import json
import sys

sys.path.insert(0, ".")
from solution import merge_orders

errors = []
passed = 0
total = 0

def check(name, condition, detail=""):
    global passed, total
    total += 1
    if condition:
        passed += 1
    else:
        errors.append(f"{name}: {detail}")

# 1) 基本合并
result = merge_orders("fixture_a.csv", "fixture_b.csv")
check("returns_list", isinstance(result, list), f"got {type(result).__name__}")

if isinstance(result, list):
    # 按 order_id 索引
    by_id = {r["order_id"]: r for r in result}

    # 2) order_id=1001 两边都有 → 取 updated_at 较新的（A: 2024-01-15T10:00 > B: 2024-01-15T09:00 → 应取 A 的 1234.50）
    if "1001" in by_id:
        amt = by_id["1001"].get("amount")
        check("1001_takes_newer", amt == 1234.50, f"expected 1234.50, got {amt!r}")
    else:
        check("1001_exists", False, "order_id 1001 missing from result")

    # 3) 金额归一化：'1,234.50' → 1234.5, '￥88' → 88.0
    if "1002" in by_id:
        amt = by_id["1002"].get("amount")
        check("1002_normalize", amt == 88.0, f"expected 88.0, got {amt!r}")

    # 4) 空字符串 → None（不抛异常）
    if "1003" in by_id:
        amt = by_id["1003"].get("amount")
        check("1003_empty_to_none", amt is None, f"expected None, got {amt!r}")

    # 5) 无法解析 → None（1004 的 amount='abc'）
    if "1004" in by_id:
        amt = by_id["1004"].get("amount")
        check("1004_unparseable_to_none", amt is None, f"expected None, got {amt!r}")

    # 6) 覆盖完整性：4 个 order_id 都应在结果中
    expected_ids = {"1001", "1002", "1003", "1004"}
    actual_ids = set(by_id.keys())
    check("all_ids_present", expected_ids == actual_ids,
          f"expected {expected_ids}, got {actual_ids}")

print(json.dumps({"total": total, "passed": passed, "errors": errors}))
'''

# ======================================================================
# 注册表：task_id → SandboxSpec
# ======================================================================
_SANDBOX_SPECS: Dict[str, SandboxSpec] = {
    "code_csv_merge": SandboxSpec(
        task_id="code_csv_merge",
        fixture_files={
            "fixture_a.csv": _CSV_MERGE_FIXTURE_A,
            "fixture_b.csv": _CSV_MERGE_FIXTURE_B,
        },
        test_harness=_CSV_MERGE_TEST_HARNESS,
        machine_verifiable_dims=["code_runnability"],
    ),
}


def get_sandbox_spec(task_id: str) -> SandboxSpec:
    """取一道题的沙箱规格。未知题目返回空规格（不可机验）。"""
    return _SANDBOX_SPECS.get(task_id, SandboxSpec(task_id=task_id))


def is_machine_verifiable(task_id: str) -> bool:
    """该题是否有沙箱可验规格。"""
    return task_id in _SANDBOX_SPECS


def all_verifiable_task_ids() -> List[str]:
    """所有可机验的题目 id。"""
    return list(_SANDBOX_SPECS.keys())
