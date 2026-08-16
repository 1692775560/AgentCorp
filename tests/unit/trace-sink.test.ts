/**
 * ATRun Trace 落盘（JSONL）+ 回放 round-trip 一致。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  serializeRun,
  deserializeRun,
  sinkRun,
  replayRun,
  listRunIds,
  createMemoryTraceBackend,
  setTraceBackend,
} from '@/demo/observability/traceSink';
import { createTeam, createTask, runTask } from '@/demo/agentteams-adapter';
import { mockJudge } from '@/demo/mockJudge';

const TASK = {
  title: '招募前端 Agent',
  requirement: '招聘前端组件库 Agent',
  candidateId: 'fe-07',
  candidateName: 'FrontendAgent-07',
  transcript: '面试官：如何拆分表单？\n候选：先复述需求，再按职责拆分。',
};

let backend: ReturnType<typeof createMemoryTraceBackend>;

beforeEach(() => {
  backend = createMemoryTraceBackend();
  setTraceBackend(backend);
});

describe('observability/traceSink', () => {
  it('serializeRun 产出 meta + 每步一行 + result 一行的合法 JSONL', async () => {
    const run = await runTask(createTeam(), createTask(TASK), { judge: mockJudge });
    const lines = serializeRun(run);
    expect(lines.length).toBe(run.steps.length + 2); // meta + steps + result
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe('meta');
    expect(parsed[0].runId).toBe(run.runId);
    expect(parsed.at(-1).kind).toBe('result');
    // 步骤行保留 skill 标签（Skill 调用证据随 Trace 落盘）
    const stepLines = parsed.filter((p) => p.kind === 'step');
    expect(stepLines.some((s) => s.skill === 'boss_review')).toBe(true);
  });

  it('sinkRun 落盘 → replayRun 回放：步骤与决策 round-trip 一致', async () => {
    const run = await runTask(createTeam(), createTask(TASK), { judge: mockJudge });
    const id = sinkRun(run);
    expect(listRunIds()).toContain(id);

    const replayed = replayRun(id);
    expect(replayed).not.toBeNull();
    expect(replayed!.runId).toBe(run.runId);
    expect(replayed!.status).toBe(run.status);
    expect(replayed!.steps).toEqual(run.steps);
    // QA-4：result 整体 round-trip（仅 request.judge 注入函数按约定不落盘）
    const { judge: _stripped, ...expectedRequest } = run.result!.request;
    expect(replayed!.result).toEqual({ ...run.result, request: expectedRequest });
  });

  it('损坏行跳过不阻断回放（缺 meta 才报错）', () => {
    backend.write('corrupt', [
      '{"kind":"meta","runId":"r1","teamId":"t","taskId":"k","status":"completed","ts":1}',
      '{坏行',
      '{"kind":"step","phase":"input","agent":"老板","summary":"s","status":"ok"}',
    ]);
    const run = replayRun('corrupt');
    expect(run).not.toBeNull();
    expect(run!.steps).toHaveLength(1); // 坏行被跳过，好行保留
  });

  it('replayRun 对未知 id 返回 null；损坏 JSONL 抛可读错误', async () => {
    expect(replayRun('run-nonexistent')).toBeNull();
    backend.write('broken', ['{"kind":"step"}']);
    expect(() => replayRun('broken')).toThrow('缺少 meta');
  });
});
