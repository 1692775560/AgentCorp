#!/usr/bin/env node
/**
 * 导出 HiClaw / AgentTeams 声明式清单（pnpm agentteams:export）
 * --------------------------------------------------------------------------
 * 把 src/engine/agents/roleCard.ts 的 4 张角色卡导出为 HiClaw CRD YAML，
 * 落到 docs/artifacts/hiclaw-manifest.yaml，作为「以 AgentTeams 为设计基点」的
 * 可核对证据（评审可直接对照 HiClaw v1beta1 CRD 规范逐字段核）。
 *
 * 用 esbuild 就地转译 TS（项目已依赖 esbuild，无需新增依赖），
 * 避免为一个导出脚本引入 ts-node / tsx。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outFile = join(root, 'docs/artifacts/hiclaw-manifest.yaml');
const tmpFile = join(root, 'node_modules/.cache/agentcorp-hiclaw-export.mjs');

mkdirSync(dirname(tmpFile), { recursive: true });

// 打成单文件 ESM（把 @/ alias 解析到 src/）
await build({
  entryPoints: [join(root, 'src/demo/agentteams/hiclawCrd.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: tmpFile,
  logLevel: 'silent',
  alias: { '@': join(root, 'src') },
});

const mod = await import(pathToFileURL(tmpFile).href);
const yaml = mod.exportHiclawManifest('agentcorp-core');

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, yaml, 'utf8');

const docCount = yaml.split('\n---\n').length;
console.log(`✅ HiClaw 清单已导出：docs/artifacts/hiclaw-manifest.yaml（${docCount} 个 CRD 文档）`);
console.log('\n迁移成本自查表：');
for (const row of mod.MIGRATION_MATRIX) {
  console.log(`  [${row.cost}] ${row.concern}：${row.agentcorpNow} → ${row.hiclawTarget}`);
}
