/**
 * tests/unit/interview.userQuestion.test.ts
 *
 * 面试用户自定义题单测（T04）：
 * - startUserQuestion 复用 arena compare（context='interview' + interviewId），
 *   成功 → userQuestionRound + status=ready
 * - 校验：空问题 / 候选不足 / 无会话
 * - pickUserQuestion 复用 arena user-pick，成功 → status=picked 且落库（save 被调）
 * - 用户题**不进 turns[]**（turns 长度不变）
 * - resetUserQuestion 清空状态
 * - finishSession 报告包含 userQuestionRound
 *
 * 隔离：mock '@/services/judgeClient'（arenaCompare/arenaUserPick）。
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/judgeClient', () => ({
  arenaCompare: vi.fn(),
  arenaUserPick: vi.fn(),
}));

// 让面试报告落库在测试中直接记录调用（不进真实 electron-store）
const savedReports: any[] = [];
vi.mock('@/services/interviewStore', () => ({
  save: vi.fn(async (report: any) => {
    savedReports.push(report);
  }),
  saveUserQuestionRound: vi.fn(async () => {}),
  load: vi.fn(async () => undefined),
  list: vi.fn(async () => []),
  listByAgent: vi.fn(async () => []),
  latestByAgent: vi.fn(async () => null),
}));

// scoringStore 等依赖在测试中保持原样（zustand 纯内存，无副作用）
import { useInterviewStore } from '@/stores/interview';
import { useArenaStore } from '@/stores/arenaStore';
import { arenaCompare, arenaUserPick } from '@/services/judgeClient';

const mockedCompare = vi.mocked(arenaCompare);
const mockedPick = vi.mocked(arenaUserPick);

function makeMatch() {
  return {
    matchId: 'am-itv-1',
    context: 'interview',
    interviewId: 'itv-test-1',
    requirementText: '预算砍半你会怎么调整？',
    taskPrompt: '【任务背景】\n预算砍半你会怎么调整？',
    jobType: 'code',
    candidates: [
      {
        agentId: 'a1',
        agentName: '甲',
        answerText: '方案一：砍掉非核心功能',
        channel: 'text',
        latencyMs: 5,
        judgement: { dims: { code_runnability: 4 }, fit: 3.5 },
        objectiveTotal: 3.8,
      },
      {
        agentId: 'a2',
        agentName: '乙',
        answerText: '方案二：换更便宜的技术栈',
        channel: 'text',
        latencyMs: 6,
        judgement: { dims: { code_runnability: 3 }, fit: 4 },
        objectiveTotal: 3.4,
      },
    ],
    objectiveLeader: 'a1',
    userPick: null,
    status: 'pending',
    eloDelta: {},
    createdAt: '2026-08-08T00:00:00Z',
  };
}

function makePickResult() {
  return {
    matchId: 'am-itv-1',
    status: 'picked',
    userPick: 'a1',
    winner: 'a1',
    eloDelta: { a1: 12, a2: -12 },
    subjectiveRatings: { a1: 1012, a2: 988 },
    objectiveRatings: { a1: 1008, a2: 992 },
  };
}

const candidates = [
  { agentId: 'a1', agentName: '甲', channel: 'text' as const, answer: '方案一' },
  { agentId: 'a2', agentName: '乙', channel: 'text' as const, answer: '方案二' },
];

describe('interview.userQuestionRound', () => {
  beforeEach(() => {
    useInterviewStore.getState().reset();
    useArenaStore.getState().reset();
    savedReports.length = 0;
    mockedCompare.mockReset();
    mockedPick.mockReset();
  });

  it('无会话时 startUserQuestion 报错', async () => {
    const ok = await useInterviewStore.getState().startUserQuestion('问题', candidates);
    expect(ok).toBe(false);
    expect(useInterviewStore.getState().userQuestionError).toContain('面试会话');
  });

  it('startUserQuestion 复用 arena compare（context=interview + interviewId）', async () => {
    mockedCompare.mockResolvedValue(makeMatch() as never);
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
      createdBy: 'hr',
    });
    const ok = await useInterviewStore.getState().startUserQuestion('预算砍半你会怎么调整？', candidates);
    expect(ok).toBe(true);
    const st = useInterviewStore.getState();
    expect(st.userQuestionStatus).toBe('ready');
    expect(st.userQuestionRound?.question).toBe('预算砍半你会怎么调整？');
    expect(st.userQuestionRound?.matchId).toBe('am-itv-1');
    expect(st.userQuestionRound?.pick).toBeNull();
    expect(st.userQuestionRound?.candidates).toHaveLength(2);
    expect(mockedCompare).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'interview',
        interviewId: expect.stringContaining('itv-'),
      }),
    );
  });

  it('startUserQuestion 空问题报错且不发请求', async () => {
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    const ok = await useInterviewStore.getState().startUserQuestion('   ', candidates);
    expect(ok).toBe(false);
    expect(useInterviewStore.getState().userQuestionError).toContain('不能为空');
    expect(mockedCompare).not.toHaveBeenCalled();
  });

  it('startUserQuestion 候选不足报错', async () => {
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    const ok = await useInterviewStore.getState().startUserQuestion('问题', [candidates[0]]);
    expect(ok).toBe(false);
    expect(useInterviewStore.getState().userQuestionError).toContain('至少需要两个候选');
  });

  it('startUserQuestion 后端失败 → error 降级', async () => {
    mockedCompare.mockResolvedValue(null as never);
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    const ok = await useInterviewStore.getState().startUserQuestion('问题', candidates);
    expect(ok).toBe(false);
    expect(useInterviewStore.getState().userQuestionStatus).toBe('error');
    expect(useInterviewStore.getState().userQuestionError).toContain('对决服务不可用');
  });

  it('pickUserQuestion 复用 arena user-pick 并落库', async () => {
    mockedCompare.mockResolvedValue(makeMatch() as never);
    mockedPick.mockResolvedValue(makePickResult() as never);
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    await useInterviewStore.getState().startUserQuestion('预算砍半你会怎么调整？', candidates);

    // 先完成面试（报告落库一次），再 pick → 触发二次保存（带 userQuestionRound.pick）
    const report = await useInterviewStore.getState().finishSession();
    expect(report?.userQuestionRound?.pick).toBeNull(); // 未 pick 前用户题小节 pick 为空

    const ok = await useInterviewStore.getState().pickUserQuestion('a1');
    expect(ok).toBe(true);
    const st = useInterviewStore.getState();
    expect(st.userQuestionStatus).toBe('picked');
    expect(st.userQuestionRound?.pick).toBe('a1');
    expect(mockedPick).toHaveBeenCalledWith({ matchId: 'am-itv-1', pick: 'a1' });
    // 落库：pick 后 save 被再次调用且报告带 userQuestionRound
    const lastSaved = savedReports[savedReports.length - 1];
    expect(lastSaved?.userQuestionRound?.pick).toBe('a1');
  });

  it('用户题不进 turns[]', async () => {
    mockedCompare.mockResolvedValue(makeMatch() as never);
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    const turnsBefore = useInterviewStore.getState().turns.length;
    await useInterviewStore.getState().startUserQuestion('问题', candidates);
    expect(useInterviewStore.getState().turns.length).toBe(turnsBefore);
  });

  it('finishSession 报告包含 userQuestionRound（pick 后）', async () => {
    mockedCompare.mockResolvedValue(makeMatch() as never);
    mockedPick.mockResolvedValue(makePickResult() as never);
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    await useInterviewStore.getState().startUserQuestion('预算砍半你会怎么调整？', candidates);
    await useInterviewStore.getState().pickUserQuestion('a1');
    const report = await useInterviewStore.getState().finishSession();
    expect(report?.userQuestionRound?.matchId).toBe('am-itv-1');
    expect(report?.userQuestionRound?.pick).toBe('a1');
  });

  it('resetUserQuestion 清空状态', async () => {
    mockedCompare.mockResolvedValue(makeMatch() as never);
    useInterviewStore.getState().startSession({
      agentId: 'agent-x',
      agentName: 'X',
      jobType: 'code',
    });
    await useInterviewStore.getState().startUserQuestion('问题', candidates);
    useInterviewStore.getState().resetUserQuestion();
    const st = useInterviewStore.getState();
    expect(st.userQuestionRound).toBeNull();
    expect(st.userQuestionStatus).toBe('idle');
  });
});
