"""
scripts/eval/dsh/agentcorp_eval_provider.py
AgentCorp 评测 Provider —— 供 DeepSeek Harness (dsh) 消费的 eval provider（Option 2）。

本文件是「真实」provider：run_sample 通过 HTTP 调 AgentCorp 的 /api/chat-judge
（由 electron Host API 代理 / model-service :8000 提供），k 次重复采样后聚合
pass^k / majority verdict / Krippendorff α。生产环境这些纯函数核心由 model-service
持有真源，此处为标准库纯 python 重实现（零外部依赖），逻辑与
src/services/judgeEnsemble.ts + src/engine/evaluation/passK.ts + ranking.ts 严格对齐。

铁律：本文件不 import 任何 dsh / cordis 符号；dsh 仅作为外部编排器调用本 provider。
"""
from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

RADAR_DIMS = ["task", "quality", "comm", "creativity", "reliability", "cost"]


@dataclass
class EvalSample:
    sample_id: str
    task: str
    transcript: str
    agent_id: str


@dataclass
class EvalResult:
    sample_id: str
    radar: dict  # 均值六维
    verdict: Optional[str]
    pass_k: dict  # pass^k 结论
    agreement_alpha: Optional[float]
    source: str  # judge | mixed | degraded
    confidence: float
    evidence_trace: list = field(default_factory=list)


# ───────────── 纯函数核心（对齐 TS 实现） ─────────────

def aggregate_radars(radars):
    """逐维均值（对齐 judgeEnsemble.aggregateRadars）。"""
    out = {d: 0.0 for d in RADAR_DIMS}
    valid = [r for r in radars if isinstance(r, dict)]
    if not valid:
        return out
    for d in RADAR_DIMS:
        s = sum(r.get(d, 0) or 0 for r in valid)
        out[d] = round(s / len(valid), 1)
    return out


def majority_verdict(verdicts):
    """多数裁决（对齐 judgeEnsemble.majorityVerdict）。"""
    counts = {}
    for v in verdicts:
        if not v:
            continue
        counts[v] = counts.get(v, 0) + 1
    best, best_c = None, 0
    for v, c in counts.items():
        if c > best_c:
            best, best_c = v, c
    return best


def _dim_pass(radar, dim, threshold):
    if not isinstance(radar, dict):
        return False
    v = radar.get(dim)
    return isinstance(v, (int, float)) and v >= threshold


def _is_all_dim_pass(radar, threshold, dims=RADAR_DIMS):
    if not isinstance(radar, dict):
        return False
    return all(_dim_pass(radar, d, threshold) for d in dims)


def pass_k(radars, threshold=3.5):
    """pass^k 可靠性结论（对齐 src/engine/evaluation/passK.ts#passK）。"""
    runs = [r for r in radars if isinstance(r, dict)]
    dims = RADAR_DIMS
    if not runs:
        return {
            "mode": "repeat", "k": 0, "allPass": False, "passRate": 0.0,
            "meanRadar": {d: 0.0 for d in dims},
            "dimPassRate": {d: 0.0 for d in dims}, "sampleCount": 0,
        }
    mean = aggregate_radars(runs)
    dim_pass = {}
    for d in dims:
        p = sum(1 for r in runs if _dim_pass(r, d, threshold))
        dim_pass[d] = round(p / len(runs), 2)
    round_passes = sum(1 for r in runs if _is_all_dim_pass(r, threshold, dims))
    pass_rate = round(round_passes / len(runs), 2)
    return {
        "mode": "repeat", "k": len(runs),
        "allPass": round_passes == len(runs),
        "passRate": pass_rate, "meanRadar": mean,
        "dimPassRate": dim_pass, "sampleCount": len(runs),
    }


def krippendorff_alpha(ratings):
    """Krippendorff's α（ordinal 特例，多评委 × 多候选）。
    对齐 src/engine/evaluation/ranking.ts#krippendorffAlphaMulti：
    α = 1 − Do/De；Do=同候选内不同评委平均距离，De=所有值两两配对平均距离。
    返回 [-1,1]：≥0.67 可接受；<0.41 不可用。"""
    n = len(ratings)
    if n < 2:
        return 0.0
    values = []
    for row in ratings:
        for v in row:
            if isinstance(v, (int, float)) and math.isfinite(v):
                values.append(float(v))
    if len(values) < 2:
        return 0.0
    de = sum(abs(values[i] - values[j]) for i in range(len(values)) for j in range(len(values)))
    de = de / (len(values) ** 2)
    do = 0.0
    do_count = 0
    for row in ratings:
        valid = [v for v in row if isinstance(v, (int, float)) and math.isfinite(v)]
        for i in range(len(valid)):
            for j in range(i + 1, len(valid)):
                do += abs(valid[i] - valid[j])
                do_count += 1
    if do_count == 0:
        return 0.0
    do = do / do_count
    if de <= 0:
        return 1.0
    return round(1 - do / de, 3)


def audit_judge_bias(radars):
    """简化移植：逐维 max-min spread；任一维 spread >= 4 判定 unstable。
    对齐 judgeEnsemble.auditJudgeBias 的 unstable 语义（阈值以 TS 真源为准）。"""
    spreads = {}
    for d in RADAR_DIMS:
        vals = [r.get(d, 0) or 0 for r in radars if isinstance(r, dict)]
        spreads[d] = round(max(vals) - min(vals), 2) if vals else 0.0
    max_spread = max(spreads.values()) if spreads else 0.0
    return {"maxSpread": max_spread, "unstable": max_spread >= 4.0, "spreads": spreads}


def judge_ensemble(radars, verdicts, confidences, judge_count, k=3, threshold=3.5):
    """对齐 judgeChatEnsemble 的纯聚合（不含网络调用）。"""
    if not radars:
        return None
    mean = aggregate_radars(radars)
    verdict = majority_verdict(verdicts)
    confidence = round(sum(confidences) / len(confidences), 2) if confidences else 0.0
    bias = audit_judge_bias(radars)
    alpha = (
        krippendorff_alpha([[r.get(d, 0) or 0 for d in RADAR_DIMS] for r in radars])
        if len(radars) >= 2
        else None
    )
    adj = confidence
    trace = []
    if bias["unstable"]:
        adj = round(confidence * 0.8, 2)
        trace.append(
            f"⚠️ 评委离散度偏高（maxSpread={bias['maxSpread']}）：结论置信已下调，建议人工复核或增采 k"
        )
    elif alpha is not None and alpha < 0.67:
        adj = round(confidence * 0.9, 2)
        trace.append(
            f"⚠️ 评委一致性偏低（Krippendorff α={alpha} < 0.67）：存在整体偏移，置信已下调，建议人工复核"
        )
    pk = pass_k(radars, threshold)
    source = "degraded" if judge_count == 0 else ("judge" if judge_count == len(radars) else "mixed")
    return {
        "source": source,
        "judgeCount": judge_count,
        "radar": mean,
        "verdict": verdict,
        "confidence": adj,
        "pass_k": pk,
        "agreement_alpha": alpha,
        "evidence_trace": trace,
    }


# ───────────── 真实 provider（HTTP 调 /api/chat-judge） ─────────────

class AgentCorpEvalProvider:
    name = "agentcorp"

    def __init__(self, judge_base="http://127.0.0.1:3210", k=3, threshold=3.5):
        self.judge_base = judge_base
        self.k = k
        self.threshold = threshold

    def _call_judge(self, agent_id, transcript):
        payload = json.dumps({"agent_id": agent_id, "transcript": transcript}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.judge_base}/api/chat-judge",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status != 200:
                    return None
                data = json.loads(resp.read().decode("utf-8"))
                radar = data.get("radar")
                return {
                    "radar": radar if isinstance(radar, dict) else None,
                    "verdict": data.get("verdict"),
                    "confidence": float(data.get("confidence", 0) or 0),
                    "source": data.get("source", "degraded"),
                }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
            return None

    def run_sample(self, sample):
        radars, verdicts, confidences = [], [], []
        judge_count = 0
        for _ in range(self.k):
            r = self._call_judge(sample.agent_id, sample.transcript)
            if not r or not r["radar"]:
                continue
            radars.append(r["radar"])
            if r["verdict"]:
                verdicts.append(r["verdict"])
            confidences.append(r["confidence"])
            if r["source"] == "judge":
                judge_count += 1
        result = judge_ensemble(radars, verdicts, confidences, judge_count, self.k, self.threshold)
        if result is None:
            return None
        return EvalResult(
            sample_id=sample.sample_id,
            radar=result["radar"],
            verdict=result["verdict"],
            pass_k=result["pass_k"],
            agreement_alpha=result["agreement_alpha"],
            source=result["source"],
            confidence=result["confidence"],
            evidence_trace=result["evidence_trace"],
        )
