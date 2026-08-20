/**
 * electron/services/experience/shared-capsule-backend.ts
 * 群体经验共享后端协议 + Filesystem 实现（主进程）。
 *
 * 设计理念（用户战略阐述）：
 * AgentCorp 本地端数据保留在用户本地，但单用户数据无法进化评测体系。
 * 群体经验共享把脱敏后的公共胶囊跨用户共享。本模块是共享后端的
 * 可扩展骨架——FilesystemSharedBackend 是零服务端依赖的本地实现，
 * 让用户手动导入/导出社区包即可享受群体经验；未来 HttpSharedBackend
 * 接真实共享服务端时，只换实现不换协议。
 *
 * SharedCapsuleBackend 协议（与具体后端解耦）：
 *   fetchPublicCapsules(query) → 拉取社区共享胶囊（供 matchScore 群体维度）
 *   submitPublicCapsule(capsule) → 上传脱敏胶囊到社区
 *   importPackage(json) → 导入社区包到本地共享池
 *   exportPackage(query) → 导出本地共享池为社区包
 *
 * FilesystemSharedBackend 实现：
 *   - 落盘 ~/.openclaw/capsules/shared.jsonl（每行一颗 PublicCapsule）
 *   - 零服务端依赖：用户手动上传/下载包文件分享
 *   - 未来换 HttpSharedBackend 时协议不变
 *
 * 容错（与 capsule-store 同口径）：任何失败吞掉，绝不阻塞。
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { getOpenClawConfigDir } from '../../utils/paths';
import type { PublicCapsule, PublicCapsulePackage, PublicCapsuleQuery } from '../../../src/types/public-capsule';
import {
  parsePublicPackage,
  findSimilarPublicCapsules,
} from '../../../src/engine/experience/publicDigest';

/** 共享后端协议：任何实现（Filesystem/Http/...）都满足此接口。 */
export interface SharedCapsuleBackend {
  /** 拉取社区共享胶囊（可按条件过滤）。best-effort，永不抛出。 */
  fetchPublicCapsules(query?: PublicCapsuleQuery): Promise<PublicCapsule[]>;
  /** 上传脱敏胶囊到社区。best-effort，返回是否成功。 */
  submitPublicCapsule(capsule: PublicCapsule): Promise<boolean>;
  /** 导入社区包（JSON 字符串或对象）到本地共享池。返回导入统计。 */
  importPackage(raw: string | unknown): Promise<{ imported: number; skipped: number; ok: boolean }>;
  /** 导出本地共享池为社区包（可按条件过滤）。 */
  exportPackage(query?: PublicCapsuleQuery): Promise<PublicCapsulePackage>;
}

/** 共享池落盘路径（~/.openclaw/capsules/shared.jsonl） */
function sharedFilePath(dirOverride?: string): string {
  return join(dirOverride ?? getOpenClawConfigDir(), 'capsules', 'shared.jsonl');
}

/** 读取全部共享胶囊（按 createdAt 升序）。文件缺失/损坏返回 []，永不抛出。 */
async function readSharedCapsules(dirOverride?: string): Promise<PublicCapsule[]> {
  try {
    const raw = await readFile(sharedFilePath(dirOverride), 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line) as PublicCapsule;
        } catch {
          return null;
        }
      })
      .filter((c): c is PublicCapsule => c != null)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  } catch {
    return [];
  }
}

/**
 * Filesystem 共享后端：零服务端依赖的本地实现。
 * 用户手动导入/导出社区包文件即可分享群体经验。
 * 未来换 HttpSharedBackend 时，协议不变，只换实现。
 */
export class FilesystemSharedBackend implements SharedCapsuleBackend {
  constructor(private readonly dirOverride?: string) {}

  async fetchPublicCapsules(query?: PublicCapsuleQuery): Promise<PublicCapsule[]> {
    const all = await readSharedCapsules(this.dirOverride);
    if (!query) return all;
    return findSimilarPublicCapsules(all, query);
  }

  async submitPublicCapsule(capsule: PublicCapsule): Promise<boolean> {
    try {
      const dir = join(this.dirOverride ?? getOpenClawConfigDir(), 'capsules');
      await mkdir(dir, { recursive: true });
      const line = `${JSON.stringify(capsule)}\n`;
      await appendFile(sharedFilePath(this.dirOverride), line, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  async importPackage(raw: string | unknown): Promise<{
    imported: number;
    skipped: number;
    ok: boolean;
  }> {
    const parsed = parsePublicPackage(raw);
    if (!parsed.ok || parsed.capsules.length === 0) {
      return { imported: 0, skipped: parsed.skipped, ok: parsed.ok };
    }
    const dir = join(this.dirOverride ?? getOpenClawConfigDir(), 'capsules');
    try {
      await mkdir(dir, { recursive: true });
      const lines = parsed.capsules.map((c) => JSON.stringify(c)).join('\n') + '\n';
      await appendFile(sharedFilePath(this.dirOverride), lines, 'utf8');
    } catch {
      // 落盘失败：仍返回导入数（调用方知道落盘失败可重试）
      return { imported: 0, skipped: parsed.skipped + parsed.capsules.length, ok: false };
    }
    return { imported: parsed.capsules.length, skipped: parsed.skipped, ok: true };
  }

  async exportPackage(query?: PublicCapsuleQuery): Promise<PublicCapsulePackage> {
    const capsules = await this.fetchPublicCapsules(query);
    return {
      kind: 'agentcorp-public-capsules',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      capsules,
      source: 'local-shared-pool',
    };
  }
}

/** 默认 Filesystem 后端实例（单例，主进程内复用）。 */
let defaultBackend: FilesystemSharedBackend | null = null;
export function getDefaultSharedBackend(): FilesystemSharedBackend {
  if (!defaultBackend) defaultBackend = new FilesystemSharedBackend();
  return defaultBackend;
}
