/**
 * tests/contract/spine.test.ts
 * M3b 主干契约 · 静态不可绕过（构建期失败即 CI 红）
 * --------------------------------------------------------------------------
 * 守住 5 条主干契约中的静态可检项：
 *   1. 单入口：评估类 Host API 只经 host-api.ts / judgeClient.ts（不散落 /api/evaluate|judge|assess）。
 *   2. 单一规则源：除 scoring/registry.ts 外不得声明 RADAR_DIMS。
 *   3. 插件注册：所有 RoleCard 的 model 必须为 'inherited'（推理模型可切换而非硬编码）。
 * （留痕 / 高风险门 的运行时项见 registry.test.ts / approval.test.ts）
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

describe("M3b 主干契约 · 静态不可绕过", () => {
  const files = walk(SRC);

  it("单一规则源：除 scoring/registry.ts 外不得声明 RADAR_DIMS", () => {
    const violators = files.filter(
      (f) =>
        !f.endsWith("scoring/registry.ts") &&
        /export\s+const\s+RADAR_DIMS/.test(read(f)),
    );
    expect(violators, `在以下文件发现第二处 RADAR_DIMS 声明:\n${violators.join("\n")}`).toEqual([]);
  });

  it("评估类 Host API 只经 host-api.ts / judgeClient.ts（直接 fetch/axios 调用站点）", () => {
    // 仅匹配真实调用站点（fetch(...) / axios(...) 到评估端点），
    // 排除 i18n 文案、注释、类型文档中的偶然字符串，避免误报。
    const callSite = /(fetch|axios)\s*\([^)]*['"]\/api\/(evaluate|judge|assess)/;
    const violators = files.filter((f) => {
      if (f.endsWith("lib/host-api.ts")) return false;
      if (f.endsWith("services/judgeClient.ts")) return false;
      return callSite.test(read(f));
    });
    expect(
      violators,
      `评估端点散落在以下文件（应只经 host-api / judgeClient）:\n${violators.join("\n")}`,
    ).toEqual([]);
  });

  it("所有 RoleCard 的 model 必须为 'inherited'", () => {
    const roleCard = files.find((f) => f.endsWith("agents/roleCard.ts"));
    expect(roleCard, "未找到 roleCard.ts").toBeDefined();
    const models = [
      ...read(roleCard!).matchAll(/model\s*:\s*["']([^"']+)["']/g),
    ].map((m) => m[1]);
    expect(models.length, "roleCard.ts 中未发现任何 model: 字段").toBeGreaterThan(0);
    for (const m of models) {
      expect(m, `发现非 inherited 的硬编码模型：${m}`).toBe("inherited");
    }
  });
});
