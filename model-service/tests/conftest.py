"""
model-service/tests/conftest.py
全局测试夹具。

存在原因：sse_starlette 把 `AppStatus.should_exit_event` 作为**类属性单例**持有
（sse.py:234 仅在其为 None 时创建一次）。每个 TestClient 会启动自己的 event loop，
于是第一个跑 SSE 的测试文件创建的 Event 会绑定在它那个 loop 上，之后其他文件的
TestClient 再 await 同一个 Event 就抛：

    RuntimeError: <asyncio.locks.Event ...> is bound to a different event loop

表现为「单文件跑全绿、全量跑 8 个 SSE 接口测试失败」。这是测试环境的跨文件状态
泄漏，不是被测代码的缺陷 —— 生产环境单进程只有一个 loop，不会触发。
"""
from __future__ import annotations

import os
import sys

import pytest

# 让测试能 import app 包（命名空间包，无 __init__.py）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# MOCK=true 保证接口测试走 Mock（不触达模型 / 网络）
os.environ.setdefault("MOCK", "true")


def reset_sse_app_status() -> None:
    """把 sse_starlette 的 Event 单例置回 None，令其在下次使用时于当前 loop 内重建。"""
    try:
        from sse_starlette.sse import AppStatus
    except ImportError:  # sse_starlette 未安装时不阻塞其余单元测试
        return
    AppStatus.should_exit_event = None
    AppStatus.should_exit = False


@pytest.fixture(autouse=True)
def _reset_sse_app_status():
    """每个测试前后重置，隔离**跨测试**的 loop 泄漏。

    autouse 是有意的：SSE 测试散落在多个文件里，靠各自记得声明夹具必然遗漏，
    而重置成本只是把一个类属性置回 None。
    """
    reset_sse_app_status()
    yield
    reset_sse_app_status()


@pytest.fixture
def reset_sse():
    """供**单个测试内多次** client.stream() 的用例手动调用。

    TestClient 每次请求都会新建 portal 及其 event loop，所以同一测试里第二次
    流式请求就会撞上第一次遗留的 Event。autouse 夹具只在测试边界生效，管不到
    测试内部，这类用例需在每次 stream 前显式调用。
    """
    return reset_sse_app_status
