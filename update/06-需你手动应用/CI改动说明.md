# ⚠️ 需要你手动应用的一处改动：`.github/workflows/ci.yml`

## 为什么需要手动

推送时被 GitHub 拒绝：

```
! [remote rejected] refusing to allow a GitHub App to create or update
  workflow `.github/workflows/ci.yml` without `workflows` permission
```

这是 GitHub 的安全策略——App 身份不允许改 workflow 文件。
因此这一处改动**已从提交中撤回**，需要你在本地或 GitHub 网页端手动改。

## 为什么必须改

不改的话，CI 的 model-service job **仍然能过**（因为它手动 `pip install httpx`），
但存在两个问题：

1. **本地开发者踩坑**：任何人 clone 后跑
   `pip install -r requirements.txt && pytest` 会直接 **4 个测试文件收集失败**
   （starlette TestClient 需要 `httpx<0.28`，requirements.txt 里没有）。
   评委如果本地验证，第一步就卡住。
2. CI 里 `pip install httpx` 没有版本上限，未来 httpx 发新版可能突然挂。

新增的 `model-service/requirements-dev.txt` 已经解决了根因，CI 只需改成用它。

## 怎么改

打开 `.github/workflows/ci.yml`，找到 `model-service` job，做两处替换：

### 替换 1：依赖安装

```yaml
# 改前
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r model-service/requirements.txt
          pip install httpx

# 改后
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install -r model-service/requirements.txt -r model-service/requirements-dev.txt
```

### 替换 2：缓存 key（可选但建议）

```yaml
# 改前
          cache-dependency-path: model-service/requirements.txt

# 改后
          cache-dependency-path: |
            model-service/requirements.txt
            model-service/requirements-dev.txt
```

## 验证

改完后本地跑一遍，应当看到 `271 passed, 6 skipped`：

```bash
cd model-service
pip install -r requirements.txt -r requirements-dev.txt
MOCK=true python -m pytest tests/ -q
```

> 注：`model-service/requirements-dev.txt` 本身**已经提交进仓库**了，
> 只有 workflow 文件这一处需要你手动改。
