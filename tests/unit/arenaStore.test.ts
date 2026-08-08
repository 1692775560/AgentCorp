/**
 * tests/unit/arenaStore.test.ts
 *
 * Arena 对决 store 单测（T03）：
 * - 需求输入 / 工种 / 候选增删
 * - compare 成功 → match + history + status=ready
 * - compare 失败（judgeClient 返回 null）→ status=error 降级提示
 * - compare 校验：空需求 / 候选不足
 * - pick 成功 → eloSnapshot + status=picked；pick 幂等（重复 pick 报错）
 * - pick 失败回传 null → error
 *
 * 隔离：mock '@/services/judgeClient'（arenaCompare / arenaUserPick）。
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/judgeClient', () => ({
  arenaCompare: vi.fn(),
  arenaUserPick: vi.fn(),
}));

import { useArenaStore } from '@/stores/arenaStore';
import { arenaCompare, arenaUserPick } from '@/services/judgeClient';
import type { ArenaMatch, ArenaPickResult } from '@/types/arena';

const mockedCompare = vi.mocked(arenaCompare);
const mockedPick = vi.mocked(arenaUserPick);

function makeMatch(overrides: Partial<ArenaMatch> = {}): ArenaMatch {
  return {
    matchId: 'am-test-1',
    context: 'arena',
    requirementText: '要一个稳定的后端 agent',
    taskPrompt: '【任务背景】\n要一个稳定的后端 agent\n【任务要求】...',
    jobType: 'code',
    candidates: [
      {
        agentId: 'a1',
        agentName: '甲',
        answerText: '方案一',
        channel: 'text',
        latencyMs: 10,
        judgement: { dims: { code_runnability: 4 }, fit: 3.5 },
        objectiveTotal: 3.8,
      },
      {
        agentId: 'a2',
        agentName: '乙',
        answerText: '方案二',
        channel: 'text',
        latencyMs: 12,
        judgement: { dims: { code_runnability: 3 }, fit: 4 },
        objectiveTotal: 3.4,
      },
    ],
    objectiveLeader: 'a1',
    userPick: null,
    status: 'pending',
    eloDelta: {},
    createdAt: '2026-08-08T00:00:00Z',
    ...overrides,
  };
}

function makePickResult(overrides: Partial<ArenaPickResult> = {}): ArenaPickResult {
  return {
    matchId: 'am-test-1',
    status: 'picked',
    userPick: 'a1',
    winner: 'a1',
    eloDelta: { a1: 12, a2: -12 },
    subjectiveRatings: { a1: 1012, a2: 988 },
    objectiveRatings: { a1: 1008, a2: 992 },
    ...overrides,
  };
}

describe('arenaStore', () => {
  beforeEach(() => {
    useArenaStore.getState().reset();
    mockedCompare.mockReset();
    mockedPick.mockReset();
  });

  it('初始状态', () => {
    const s = useArenaStore.getState();
    expect(s.requirementText).toBe('');
    expect(s.jobType).toBe('code');
    expect(s.candidates).toEqual([]);
    expect(s.match).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.eloSnapshot.subjectiveRatings).toEqual({});
  });

  it('需求 / 工种 / 候选增删', () => {
    const s = useArenaStore.getState();
    s.setRequirementText('需求A');
    s.setJobType('text');
    s.addCandidate({ agentId: 'a1', agentName: '甲', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', agentName: '乙', channel: 'text', answer: 'y' });
    s.addCandidate({ agentId: 'a1', agentName: '重复', channel: 'text' }); // 去重
    expect(useArenaStore.getState().candidates).toHaveLength(2);
    s.removeCandidate('a1');
    expect(useArenaStore.getState().candidates.map((c) => c.agentId)).toEqual(['a2']);
    s.clearCandidates();
    expect(useArenaStore.getState().candidates).toEqual([]);
    expect(useArenaStore.getState().jobType).toBe('text');
    expect(useArenaStore.getState().requirementText).toBe('需求A');
  });

  it('compare 成功 → match + history + status=ready', async () => {
    mockedCompare.mockResolvedValue(makeMatch());
    const s = useArenaStore.getState();
    s.setRequirementText('要一个稳定的后端 agent');
    s.addCandidate({ agentId: 'a1', agentName: '甲', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', agentName: '乙', channel: 'text', answer: 'y' });
    await s.compare();
    const st = useArenaStore.getState();
    expect(st.status).toBe('ready');
    expect(st.match?.matchId).toBe('am-test-1');
    expect(st.history).toHaveLength(1);
    expect(mockedCompare).toHaveBeenCalledWith(
      expect.objectContaining({ requirementText: '要一个稳定的后端 agent', jobType: 'code', context: 'arena' }),
    );
  });

  it('compare 后端不可用（null）→ 降级 error', async () => {
    mockedCompare.mockResolvedValue(null);
    const s = useArenaStore.getState();
    s.setRequirementText('需求');
    s.addCandidate({ agentId: 'a1', agentName: '甲', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', agentName: '乙', channel: 'text', answer: 'y' });
    await s.compare();
    const st = useArenaStore.getState();
    expect(st.status).toBe('error');
    expect(st.error).toContain('后端未启动');
    expect(st.match).toBeNull();
  });

  it('compare 空需求 → error', async () => {
    const s = useArenaStore.getState();
    s.addCandidate({ agentId: 'a1', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', channel: 'text', answer: 'y' });
    await s.compare();
    expect(useArenaStore.getState().status).toBe('error');
    expect(useArenaStore.getState().error).toContain('需求文本');
    expect(mockedCompare).not.toHaveBeenCalled();
  });

  it('compare 候选不足 → error', async () => {
    const s = useArenaStore.getState();
    s.setRequirementText('需求');
    s.addCandidate({ agentId: 'a1', channel: 'text', answer: 'x' });
    await s.compare();
    expect(useArenaStore.getState().status).toBe('error');
    expect(useArenaStore.getState().error).toContain('至少选择两个候选');
    expect(mockedCompare).not.toHaveBeenCalled();
  });

  it('pick 成功 → eloSnapshot + status=picked + history 回填', async () => {
    mockedCompare.mockResolvedValue(makeMatch());
    mockedPick.mockResolvedValue(makePickResult());
    const s = useArenaStore.getState();
    s.setRequirementText('需求');
    s.addCandidate({ agentId: 'a1', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', channel: 'text', answer: 'y' });
    await s.compare();
    await useArenaStore.getState().pick('a1');
    const st = useArenaStore.getState();
    expect(st.status).toBe('picked');
    expect(st.match?.status).toBe('picked');
    expect(st.match?.userPick).toBe('a1');
    expect(st.eloSnapshot.subjectiveRatings).toEqual({ a1: 1012, a2: 988 });
    expect(st.history[0].userPick).toBe('a1');
    expect(mockedPick).toHaveBeenCalledWith({ matchId: 'am-test-1', pick: 'a1' });
  });

  it('pick 重复（match 已 picked）→ error 且不再发请求', async () => {
    mockedCompare.mockResolvedValue(makeMatch());
    mockedPick.mockResolvedValue(makePickResult());
    const s = useArenaStore.getState();
    s.setRequirementText('需求');
    s.addCandidate({ agentId: 'a1', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', channel: 'text', answer: 'y' });
    await s.compare();
    await s.pick('a1');
    mockedPick.mockClear();
    await useArenaStore.getState().pick('a2');
    expect(useArenaStore.getState().error).toContain('重复 pick');
    expect(mockedPick).not.toHaveBeenCalled();
  });

  it('pick 后端不可用（null）→ error', async () => {
    mockedCompare.mockResolvedValue(makeMatch());
    mockedPick.mockResolvedValue(null);
    const s = useArenaStore.getState();
    s.setRequirementText('需求');
    s.addCandidate({ agentId: 'a1', channel: 'text', answer: 'x' });
    s.addCandidate({ agentId: 'a2', channel: 'text', answer: 'y' });
    await s.compare();
    await s.pick('a1');
    const st = useArenaStore.getState();
    expect(st.status).toBe('error');
    expect(st.error).toContain('pick 回传失败');
    expect(st.match?.status).toBe('pending');
  });

  it('pick 无 match → error', async () => {
    await useArenaStore.getState().pick('a1');
    expect(useArenaStore.getState().error).toContain('尚无对决结果');
    expect(mockedPick).not.toHaveBeenCalled();
  });

  it('clearError 清空错误', async () => {
    const s = useArenaStore.getState();
    s.setRequirementText('需求');
    s.addCandidate({ agentId: 'a1', channel: 'text', answer: 'x' });
    await s.compare();
    expect(useArenaStore.getState().error).toContain('至少选择两个候选');
    useArenaStore.getState().clearError();
    expect(useArenaStore.getState().error).toBeNull();
  });
});
