# AgentCorp 模型服务镜像（昇腾 NPU 推理 / Mock 演示两用）
# 构建：docker build -f model-service/Dockerfile -t agentcorp-minicpmo:ascend .
FROM python:3.10-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# 先装依赖（利用层缓存）
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 拷贝服务代码
COPY app ./app
COPY tests ./tests

# 样本与上传目录（运行时挂载真实媒体）
VOLUME ["/app/samples", "/app/uploads"]

EXPOSE 8000

# 默认以 Mock 启动（无 NPU 也可运行演示）；部署时 MOCK=false 并透传 NPU 设备
ENV MOCK=true \
    API_HOST=0.0.0.0 \
    API_PORT=8000 \
    SAMPLES_DIR=/app/samples \
    UPLOAD_DIR=/app/uploads

CMD ["python", "-m", "app.serve"]
