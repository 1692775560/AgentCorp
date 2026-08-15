"""
scripts/eval/dsh/run_probe.py
自包含探针 runner —— 模拟 dsh 的 eval 编排循环，用「进程内 mock judge」跑通 Option 2 探针，
不依赖 dsh、也不必启动 model-service。验证「AgentCorp 的评分科学（pass^k / 多数裁决 /
Krippendorff α）能被 eval loop 消费并产出结构化报告」。

接入真实 dsh：把 AgentCorpEvalProvider 注册为 dsh 的 eval provider（见 profile.probe.yml），
dsh 负责把 task 喂给被测 agent、收集 transcript、调用 run_sample。评分科学完全一致。

运行：python run_probe.py
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from agentcorp_eval_provider import EvalSample, judge_ensemble, RADAR_DIMS  # noqa: E402


class MockJudge:
    """进程内 mock：基于 agent_id 哈希 + run_index 的确定性雷达，叠加小抖动。
    不调网络，仅用于证明 eval loop 能消费评分科学。"""

    def __init__(self, base=4.0, jitter=0.4):
        self.base = base
        self.jitter = jitter

    @staticmethod
    def _hash(s: str) -> int:
        h = 0x811C9DC5
        for ch in s:
            h ^= ord(ch)
            h = (h * 0x01000193) & 0xFFFFFFFF
        return h

    def judge_once(self, agent_id: str, transcript: str, run_index: int) -> dict:
        h = self._hash(agent_id)
        out = {}
        for i, d in enumerate(RADAR_DIMS):
            shift = (h >> (i * 3)) % 1000 / 1000.0
            # 基础分随维度与 agent 哈希变化，制造 agent 间区分度
            base = 3.0 + shift * 2.0
            # run_index 引入确定性抖动（模拟重复采样噪声）
            noise = ((self._hash(f"{agent_id}:{run_index}:{d}") % 1000) / 1000.0 - 0.5) * 2 * self.jitter
            out[d] = round(max(0.0, min(5.0, base + noise)), 1)
        return out


def load_samples(path):
    samples = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            samples.append(
                EvalSample(
                    sample_id=obj["sample_id"],
                    task=obj.get("task", ""),
                    transcript=obj.get("transcript", ""),
                    agent_id=obj["agent_id"],
                )
            )
    return samples


def run_probe(sample, mock, k=5, threshold=3.5):
    radars, verdicts, confidences = [], [], []
    judge_count = k  # mock 视为真裁判
    for i in range(k):
        r = mock.judge_once(sample.agent_id, sample.transcript, i)
        radars.append(r)
        avg = sum(r.values()) / len(r)
        verdicts.append("MVP" if avg >= 4 else ("OBSERVE" if avg >= 2.5 else "FIRED"))
        confidences.append(0.8)
    return judge_ensemble(radars, verdicts, confidences, judge_count, k, threshold)


def main():
    sample_path = os.path.join(HERE, "benchmarks", "probe", "sample.jsonl")
    samples = load_samples(sample_path)
    mock = MockJudge()
    print("=" * 70)
    print("AgentCorp × dsh Option 2 探针（mock judge，自包含 runner）")
    print("=" * 70)
    all_ok = True
    for s in samples:
        res = run_probe(s, mock)
        if res is None:
            all_ok = False
            print(f"[FAIL] {s.sample_id}: 无有效雷达")
            continue
        print(f"\n• sample_id : {s.sample_id}")
        print(f"  agent_id  : {s.agent_id}")
        print(f"  source    : {res['source']}  (judgeCount={res['judgeCount']})")
        print(f"  meanRadar : {res['radar']}")
        print(f"  verdict   : {res['verdict']}")
        print(f"  confidence: {res['confidence']}")
        print(
            f"  pass^k    : allPass={res['pass_k']['allPass']}  "
            f"passRate={res['pass_k']['passRate']}  k={res['pass_k']['k']}"
        )
        print(f"  dimPass   : {res['pass_k']['dimPassRate']}")
        print(f"  α(Kripp) : {res['agreement_alpha']}")
        for ev in res["evidence_trace"]:
            print(f"  ⚠ {ev}")
        ok = res["verdict"] is not None and res["agreement_alpha"] is not None
        all_ok = all_ok and ok
        print(f"  → probe line met: {'YES' if ok else 'NO'}")
    print("\n" + "=" * 70)
    print(
        f"探针总判定: {'PASS ✅' if all_ok else 'FAIL ❌'} "
        f"(§4.4 验收线：产出 pass_k/verdict/agreement_alpha)"
    )
    print("=" * 70)
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
