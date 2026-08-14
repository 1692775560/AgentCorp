#!/usr/bin/env node
/**
 * 将 agency-agents (https://github.com/msitarzewski/agency-agents, MIT) 的角色
 * 转换为人才市场模板目录: resources/marketplace/<id>/{IDENTITY.md, AGENTS.md, SOUL.md}
 *
 * 用法:
 *   node scripts/import-agency-agents.mjs <agency-agents仓库路径> [--dry-run]
 *
 * 说明:
 * - 源文件格式: <division>/<division>-<slug>.md, 带 YAML frontmatter (name/description/emoji/vibe)
 * - AGENTS.md 只生成 1 条能力, 避免 listMarketplaceTemplates 把单人角色误判为 team 卡
 * - SOUL.md 保留原文正文, 末尾附加来源与许可证声明
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const DRY_RUN = process.argv.includes('--dry-run')
const srcRoot = process.argv.find((a, i) => i > 1 && !a.startsWith('--'))
if (!srcRoot || !existsSync(srcRoot)) {
  console.error('用法: node scripts/import-agency-agents.mjs <agency-agents仓库路径> [--dry-run]')
  process.exit(1)
}

const outRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'resources', 'marketplace')

// frontmatter 极简解析(源仓库字段只有 name/description/color/emoji/vibe 这几种)
function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return { meta: {}, body: content }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\w+):\s*(.*)$/)
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  return { meta, body: content.slice(m[0].length) }
}

const ATTRIBUTION = '\n\n---\n\n> Source: [agency-agents](https://github.com/msitarzewski/agency-agents) (MIT License)'

// 递归收集目录下的 .md 文件(game-development 等含引擎子目录)
function collectMarkdown(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdown(p))
    else if (entry.name.endsWith('.md')) out.push(p)
  }
  return out
}

let created = 0
let skipped = 0
const ids = new Set()

for (const division of readdirSync(srcRoot, { withFileTypes: true })) {
  if (!division.isDirectory() || division.name.startsWith('.') || division.name === 'examples' || division.name === 'integrations' || division.name === 'scripts') {
    continue
  }
  for (const filePath of collectMarkdown(join(srcRoot, division.name))) {
    const file = basename(filePath)
    // 文件名未带部门前缀时补上, 避免与现有模板 id 冲突(如 specialized/customer-service.md)
    const stem = basename(file, '.md')
    const id = stem.startsWith(division.name) ? stem : `${division.name}-${stem}`
    if (ids.has(id)) {
      console.warn(`跳过重复 id: ${id}`)
      skipped++
      continue
    }
    const { meta, body } = parseFrontmatter(readFileSync(filePath, 'utf-8'))
    // 无 frontmatter 或缺 name/description 的是文档文件(如 strategy/ 下的 NEXUS 文档), 不是角色
    if (!meta.name || !meta.description) {
      console.warn(`跳过非角色文件: ${division.name}/${file}`)
      skipped++
      continue
    }
    const name = meta.name
    const emoji = meta.emoji || '🤖'
    const vibe = meta.vibe || meta.description || ''
    const role = meta.description || meta.vibe || ''

    const identity = [
      `# IDENTITY.md - ${name}`,
      '',
      `- **Name:** ${name}`,
      `- **Creature:** AI ${name}`,
      `- **Vibe:** ${vibe}`,
      `- **Emoji:** ${emoji}`,
      `- **Role:** ${role}`,
      '',
    ].join('\n')

    // 单行能力, 保持 hireType = single
    const agents = [
      `# AGENTS.md - ${name} 工作空间`,
      '',
      `## 能力`,
      '',
      `- **${name}**：${role}`,
      '',
    ].join('\n')

    const soul = body.trim() + ATTRIBUTION + '\n'

    if (DRY_RUN) {
      console.log(`[dry-run] ${id} | ${emoji} ${name}`)
    } else {
      const outDir = join(outRoot, id)
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, 'IDENTITY.md'), identity)
      writeFileSync(join(outDir, 'AGENTS.md'), agents)
      writeFileSync(join(outDir, 'SOUL.md'), soul)
    }
    ids.add(id)
    created++
  }
}

console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}共处理 ${created} 个角色, 跳过 ${skipped} 个, 输出目录: ${outRoot}`)
