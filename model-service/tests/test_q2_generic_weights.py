"""
Q2 最小断言：flatten_dim_weight 应消费 registry.JOB_GENERIC_WEIGHT[job_type]，
使 image 与 code 的通用六维权重向量不同，且各自 Σ=1。
不依赖 MOCK 后端，纯单元验证。
"""
import math

from app.scoring.rules_engine import flatten_dim_weight, load_rules
from app.scoring.registry import RADAR_DIMS


def _generic_vec(job_type: str) -> dict:
    dw = flatten_dim_weight("preScreen", job_type, load_rules())
    return {d: dw[d] for d in RADAR_DIMS if d in dw}


def test_q2_image_vs_code_generic_weights_differ():
    img = _generic_vec("image")
    code = _generic_vec("code")
    assert set(img.keys()) == set(RADAR_DIMS)
    # 两者向量必须不同（Q2 差异化生效）
    assert img != code
    # 以 creativity / reliability 维度为例：image 重 creativity，code 重 reliability
    assert img["creativity"] > code["creativity"]
    assert code["reliability"] > img["reliability"]


def test_q2_each_full_dimweight_sums_to_one():
    # flatten_dim_weight 整体输出（含 generic+craft）Σ=1，与既有归一化行为一致
    for jt in ("image", "text", "code"):
        dw = flatten_dim_weight("preScreen", jt, load_rules())
        assert math.isclose(sum(dw.values()), 1.0, rel_tol=1e-9)
