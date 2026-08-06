"""routes 内部共享的小工具（纯搬运自原 serve.py）。"""
from __future__ import annotations


def datetime_now_iso() -> str:
    import datetime as _dt

    return _dt.datetime.now(_dt.timezone.utc).isoformat()
