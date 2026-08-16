/**
 * src/demo/plugins/seams/judge.ts —— 评委能力接入点
 * --------------------------------------------------------------------------
 * 评委 seam：内核只认 JudgeProvider 接口，具体实现（chat-judge / 降级 / 离线）
 * 以 Provider 形式注册。与现有 /api/chat-judge HTTP 契约解耦——Provider 才是
 * 内核统一的评委入口；judgeClient 的 network 实现可包成默认 Provider 接入。
 */
import type { CapabilityKind } from '../context';
import type { RadarScore, Verdict } from '@/types/evaluation';

export const JUDGE_KIND: CapabilityKind = 'judge';

export interface JudgeRequest {
  agentId: string;
  transcript: string;
  /** variant 旋转维度顺序，对抗位置偏差 */
  variant?: number;
  /** 可选 boss 画像（透传到 judge 实现） */
  bossProfile?: unknown;
}

export interface JudgeResult {
  radar: RadarScore;
  verdict: Verdict;
  confidence: number;
  evidence: string[];
}

export interface JudgeProvider {
  id: string;
  judge(req: JudgeRequest): Promise<JudgeResult>;
}
