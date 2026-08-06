"""
model-service/app/scoring/encoder.py
需求理解摘要编码器封装 + PCA 工具（T14，架构 §3.2 / §3.5）。

设计要点（零新增运行时依赖，纯 Python，可 CPU 复现）：
- encode_summary(text) -> List[float]（默认确定性投影）：
    小写 → 分词（英文词 / 中文按字）→ token 稳定哈希映射到固定维度 d=64
    → 累加 → L2 归一化。不依赖 numpy / 模型，单测可跑、可复现。
- MiniCPM-o 4.5 作为可选后端经 CONVERGENCE_ENCODER=minicpm 启用，
    但**不在测试/无 NPU 环境调用**（抛 NotImplementedError 占位），真实接入留给运行时。
- pca2d(vectors) -> List[[x, y]]：纯 Python 幂迭代求前 2 主成分，
    固定迭代次数 + 固定初始向量 → 逐位可复现（不引 numpy）。
- ConvergenceConfig：k 默认 3、weights 默认 0.4/0.4/0.2、scale 默认 2.0，
    与架构 §3.5 默认值严格一致。

本模块只依赖标准库（hashlib / math / re / os）+ pydantic（仅用于配置模型）。
"""
from __future__ import annotations

import hashlib
import math
import os
import re
from typing import List, Optional

from pydantic import BaseModel, Field

# 默认潜在空间维度（确定性投影落点）
DEFAULT_DIM = 64

# 分词：英文/数字连续串 或 单个 CJK 汉字（兼容中英文需求摘要）
_TOKEN_RE = re.compile(r"[a-z0-9]+|[一-鿿]")


# ======================================================================
# 1) 通用数值工具（供 encoder 与 convergence 引擎共用）
# ======================================================================
def clamp(value: float, lo: float, hi: float) -> float:
    """裁剪到 [lo, hi]。"""
    return max(lo, min(hi, value))


def l2_norm(vec: List[float]) -> float:
    """L2 范数（||v||）。"""
    return math.sqrt(sum(x * x for x in vec))


def cosine_similarity(a: List[float], b: List[float]) -> float:
    """
    余弦相似度（align 函数）。
    任一向量零向量时返回 0.0（避免除零；与前端镜像一致）。
    """
    na, nb = l2_norm(a), l2_norm(b)
    if na == 0.0 or nb == 0.0:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (na * nb)


def std_pop(values: List[float]) -> float:
    """总体标准差（除以 N；N=0 时返回 0.0）。前后端同公式。"""
    n = len(values)
    if n == 0:
        return 0.0
    mean = sum(values) / n
    variance = sum((v - mean) * (v - mean) for v in values) / n
    return math.sqrt(variance)


# ======================================================================
# 2) 确定性投影编码器（默认后端）
# ======================================================================
def _token_hash(token: str) -> int:
    """稳定哈希：md5 取前 8 字节 → 非负 int（跨进程/跨运行可复现）。"""
    digest = hashlib.md5(token.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def encode_summary(text: str, dim: int = DEFAULT_DIM) -> List[float]:
    """
    把「需求理解摘要」编码为固定维度 d 的 embedding（确定性投影）。

    算法（无模型、CPU 可跑、可复现）：
      1. 转小写；
      2. 按 _TOKEN_RE 分词（英文词 / 中文单字）；
      3. 每个 token 稳定哈希 → 落维度 idx = hash % d，向量该维 +1；
      4. 全向量 L2 归一化（零向量则原样返回全 0）。

    该投影是「语义→潜在空间」的可复现代理：同义改写（相同 token 集合）
    得到近似向量，满足编码器标定（同义改写一致性）的可测要求。
    """
    vec = [0.0] * dim
    if not text:
        return vec
    lowered = text.lower()
    for tok in _TOKEN_RE.findall(lowered):
        idx = _token_hash(tok) % dim
        vec[idx] += 1.0
    norm = l2_norm(vec)
    if norm == 0.0:
        return vec
    return [x / norm for x in vec]


# ======================================================================
# 3) 可选 MiniCPM-o 后端（仅运行时启用，测试环境抛 NotImplementedError）
# ======================================================================
def encode_summary_minicpm(text: str, dim: int = DEFAULT_DIM) -> List[float]:
    """
    可选后端：MiniCPM-o 4.5 编码（复用 judge 底座）。
    测试/无 NPU 环境不调用 → 抛 NotImplementedError 占位，
    真实接入由运行时环境落位（不在此实现，避免引入重依赖）。
    """
    raise NotImplementedError(
        "MiniCPM-o 编码后端仅在运行时环境启用（CONVERGENCE_ENCODER=minicpm）；"
        "测试/无 NPU 环境请使用默认确定性投影 encode_summary。"
    )


def encode_summary_auto(text: str, dim: int = DEFAULT_DIM) -> List[float]:
    """按环境变量选择编码器；缺省走确定性投影。"""
    backend = os.getenv("CONVERGENCE_ENCODER", "deterministic").lower()
    if backend == "minicpm":
        return encode_summary_minicpm(text, dim)
    return encode_summary(text, dim)


# ======================================================================
# 4) 纯 Python PCA（幂迭代前 2 主成分，确定性可复现）
# ======================================================================
def _matvec(M: List[List[float]], v: List[float]) -> List[float]:
    """矩阵 × 向量（M 为 d×d，v 为 d 维）。"""
    return [sum(row[i] * v[i] for i in range(len(v))) for row in M]


def _dot(a: List[float], b: List[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def _power_iterate(C: List[List[float]], init: List[float], n_iter: int = 100) -> List[float]:
    """
    幂迭代求主特征向量：固定迭代次数 + 固定初始向量 → 可复现。
    每步 v = C·v 后 L2 归一化。
    """
    v = list(init)
    n = l2_norm(v)
    v = [x / n for x in v] if n > 0 else v
    for _ in range(n_iter):
        v = _matvec(C, v)
        nv = l2_norm(v)
        if nv == 0.0:
            break
        v = [x / nv for x in v]
    return v


def pca2d(vectors: List[List[float]]) -> List[List[float]]:
    """
    把 N 个 d 维向量投影到 2D（前 2 主成分），返回 [[x,y], ...]。
    纯 Python 实现（不引 numpy），确定性可复现：
      - 中心化；
      - 协方差 C = XᵀX / N；
      - 幂迭代求第 1 主成分 v1；
      - 减秩（C2 = C − (v1ᵀCv1)·v1v1ᵀ）后幂迭代求 v2（不同初始向量）；
      - 各点投影到 (v1, v2)。

    边界：
      - 空输入 → []；
      - 单点 → [[0,0]]；
      - 全相同点 → 协方差为零，投影全为 [0,0]（确定性）。
    """
    n = len(vectors)
    if n == 0:
        return []
    if n == 1:
        return [[0.0, 0.0]]

    d = len(vectors[0])
    # 中心化
    mean = [sum(vectors[i][j] for i in range(n)) / n for j in range(d)]
    X = [[vectors[i][j] - mean[j] for j in range(d)] for i in range(n)]

    # 协方差矩阵 C = Xᵀ X / n （d×d）
    C: List[List[float]] = [[0.0] * d for _ in range(d)]
    for a in range(d):
        for b in range(d):
            s = 0.0
            for i in range(n):
                s += X[i][a] * X[i][b]
            C[a][b] = s / n

    # 第 1 主成分（初始向量 e1 = [1,0,...,0]）
    v1 = _power_iterate(C, [1.0] + [0.0] * (d - 1))

    # 减秩后求第 2 主成分（初始向量 e2 = [0,1,0,...,0]，避免收敛到同一向量）
    lambda1 = _dot(v1, _matvec(C, v1))
    C2: List[List[float]] = [[0.0] * d for _ in range(d)]
    for a in range(d):
        for b in range(d):
            C2[a][b] = C[a][b] - lambda1 * v1[a] * v1[b]
    v2 = _power_iterate(C2, [0.0, 1.0] + [0.0] * (d - 2))

    # 投影
    out: List[List[float]] = []
    for i in range(n):
        x = _dot(X[i], v1)
        y = _dot(X[i], v2)
        out.append([x, y])
    return out


# ======================================================================
# 5) 收敛配置（架构 §3.5 默认值）
# ======================================================================
class ConvergenceConfig(BaseModel):
    """
    收敛引擎可配参数（与架构 §3.5 严格一致）：
      - k：默认轮数 3（可配 5/7 等）；
      - weights：w1/w2/w3 默认 0.4/0.4/0.2（Σ=1）；
      - scale：残差校准常数，默认 2.0（单位向量最大距离）；
      - dim：确定性投影维度，默认 64。
    """

    k: int = Field(default=3, ge=1, description="默认轮数 K（可配）")
    w1: float = Field(default=0.4, description="收缩率权重")
    w2: float = Field(default=0.4, description="残差项权重（作用于 1−R）")
    w3: float = Field(default=0.2, description="稳定度权重")
    scale: float = Field(default=2.0, gt=0.0, description="残差校准常数（单位向量最大距离）")
    dim: int = Field(default=DEFAULT_DIM, ge=1, description="确定性投影维度")

    def weights_dict(self) -> dict:
        return {"w1": self.w1, "w2": self.w2, "w3": self.w3}
