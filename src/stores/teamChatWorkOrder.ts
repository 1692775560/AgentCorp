/**
 * src/stores/teamChatWorkOrder.ts
 * 会话派活执行器：把团队任务会话里老板对 leader 下的工作指令，
 * 落成一次真实的多成员编排（leader 拆解分派 → 成员执行 → 审阅 → 汇总交付）。
 *
 * 与 autoWorker 的区别：autoWorker 面向看板「待办」任务的自动领取；
 * 这里面向「评审中/已完成」任务的追加指令——复用同一套编排引擎，
 * a2a trace 实时写回任务事件流（会话气泡与看板时间线同步可见），
 * 看板状态随任务状态机流转（in-progress → review）。
 */
import { useAgentsStore } from '@/stores/agents';
import { useApprovalsStore } from '@/stores/approvals';
import { useTeamsStore } from '@/stores/teams';
import { createThrottledEventSink, projectRoutingCandidates } from '@/stores/autoWorker';
import { runSquadOrchestration } from '@/engine/squad/squadOrchestration';
import { buildDeliverableFiles } from '@/engine/squad/deliverableFiles';
import { runRealChat } from '@/engine/llm/realExecutor';
import { invokeIpc } from '@/lib/api-client';
import { notifyTaskTerminal } from '@/lib/task-notify';
import type { TaskExecutionEvent } from '@/types/task';

/** 防止同一任务并发触发两轮编排（连点/重复标记）。 */
const running = new Set<string>();

export function isWorkOrderRunning(taskId: string): boolean {
  return running.has(taskId);
}

/**
 * 执行会话派活。返回是否成功受理（false = 条件不满足，未启动）。
 * @throws 编排或落库失败时抛错，调用方负责提示。
 */
export async function runTeamChatWorkOrder(taskId: string, instruction: string): Promise<boolean> {
  const approvals = useApprovalsStore.getState();
  const task = approvals.tasks.find((t) => t.id === taskId);
  if (!task?.teamId) return false;
  const team = useTeamsStore.getState().teams.find((t) => t.id === task.teamId);
  if (!team?.leaderId || running.has(taskId)) return false;

  running.add(taskId);
  try {
    // 1) 受理留痕 + 看板转「进行中」
    await approvals.appendTaskExecutionEvent(taskId, {
      type: 'status',
      content: `收到会话指令：「${instruction.slice(0, 120)}」，leader 开始拆解分派…`,
    });
    await approvals.updateTask(taskId, { status: 'in-progress', workState: 'working' });

    // 2) 注入成员 persona，起编排；任务文本带上追加要求与已有交付，
    //    让成员在现有成果基础上改进，而不是从零重做。
    const memberIds = Array.from(new Set([...(team.memberIds ?? []), team.leaderId]));
    const personas: Record<string, string | null> = {};
    await Promise.all(
      memberIds.map(async (aid) => {
        personas[aid] = await useAgentsStore
          .getState()
          .getAgentPersona(aid)
          .catch(() => null);
      }),
    );

    // sink 写回是全量覆盖（PUT executionEvents），必须用最新事件列表预填，
    // 否则本轮编排会把之前的对话与协作历史从任务上抹掉。
    const freshTask = useApprovalsStore.getState().tasks.find((t) => t.id === taskId);
    const events: TaskExecutionEvent[] = [...(freshTask?.executionEvents ?? [])];
    const sink = createThrottledEventSink(taskId, events);
    let orch: Awaited<ReturnType<typeof runSquadOrchestration>>;
    try {
      orch = await runSquadOrchestration({
        taskId,
        taskTitle: task.title,
        taskDescription: [
          task.description,
          `【追加要求（来自会话）】${instruction}`,
          task.workResult ? `【已有交付，请在其基础上改进】\n${task.workResult.slice(0, 1500)}` : '',
        ].filter(Boolean).join('\n\n'),
        team,
        candidates: projectRoutingCandidates(team),
        personas,
        maxRounds: 2,
        chat: (_agentId, messages) => runRealChat(messages, 2048),
        onTrace: (t) => sink.push(t),
      });
    } finally {
      await sink.flush();
    }

    // 3) 汇总交付 + 文件落盘（与 autoWorker 同构）
    const passed = orch.subtasks.filter((s) => s.approved).length;
    const failedCount = orch.subtasks.filter((s) => s.error).length;
    let realOutput =
      `【团队协同·${team.name}·${orch.subtasks.length} 个子任务：${passed} 通过` +
      `${failedCount ? `，${failedCount} 失败` : ''}】\n${orch.deliverable}`;
    let deliverableDir: string | undefined;
    try {
      const files = buildDeliverableFiles(orch.subtasks, orch.deliverable);
      const saved = await invokeIpc<{ success: boolean; dir?: string; saved?: string[] }>(
        'task:saveDeliverables',
        { taskId, files },
      );
      if (saved.success && saved.dir) {
        deliverableDir = saved.dir;
        realOutput += `\n\n---\n📁 ${saved.saved?.length ?? 0} 个交付文件已保存到本地，点下方「打开交付目录」查看/运行。`;
      }
    } catch {
      /* 落盘失败不阻塞交付 */
    }

    // 4) 落终态回「待验收」，通知用户验收
    await approvals.updateTask(taskId, {
      status: 'review',
      workState: 'done',
      ...(deliverableDir ? { deliverableDir } : {}),
      workResult: realOutput.slice(0, 4000),
    });
    notifyTaskTerminal(taskId, 'done', task.title);
    return true;
  } catch (err) {
    await approvals
      .updateTask(taskId, {
        workState: 'failed',
        workError: `会话派活执行失败：${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => {});
    throw err;
  } finally {
    running.delete(taskId);
  }
}
