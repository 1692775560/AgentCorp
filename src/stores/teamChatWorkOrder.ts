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
import {
  claimTask,
  releaseClaim,
  isTaskClaimed,
  createThrottledEventSink,
  projectRoutingCandidates,
} from '@/stores/autoWorker';
import { createRoomTraceForwarder } from '@/stores/teamRoomBroadcast';
import { usePerformanceStore, subtasksToOutcomes } from '@/stores/performance';
import { useExperienceStore, buildExperienceText, reflectExperience } from '@/stores/experience';
import { runSquadOrchestration } from '@/engine/squad/squadOrchestration';
import { buildDeliverableFiles } from '@/engine/squad/deliverableFiles';
import { runRealChat } from '@/engine/llm/realExecutor';
import { invokeIpc } from '@/lib/api-client';
import { notifyTaskTerminal } from '@/lib/task-notify';

/**
 * 互斥说明：会话派活与 autoWorker 自动领取共用同一份 claimed 集合
 * （autoWorker 的 claimTask/releaseClaim），受理即占用、结束（含失败）释放；
 * 占用期间 autoWorker 的 _tick 不会重复领取同一任务。
 */
export function isWorkOrderRunning(taskId: string): boolean {
  return isTaskClaimed(taskId);
}

/**
 * 失败自救：把失败任务重新排队（回 待办/idle），AutoWorker 下一轮自动重领。
 * 看板失败卡片、团队房间失败条、任务会话失败条共用这一个入口（DRY）；
 * 与执行通道互斥——任务正被占用时不重排，返回 false。
 */
export async function retryFailedTask(taskId: string): Promise<boolean> {
  const approvals = useApprovalsStore.getState();
  const task = approvals.tasks.find((t) => t.id === taskId);
  if (!task || task.workState !== 'failed') return false;
  if (isTaskClaimed(taskId)) return false;
  await approvals.updateTask(taskId, { status: 'todo', workState: 'idle' });
  return true;
}

/**
 * 执行会话派活。返回是否成功受理（false = 条件不满足或任务已被占用，未启动）。
 * @throws 编排或落库失败时抛错，调用方负责提示。
 */
export async function runTeamChatWorkOrder(taskId: string, instruction: string): Promise<boolean> {
  const approvals = useApprovalsStore.getState();
  const task = approvals.tasks.find((t) => t.id === taskId);
  if (!task?.teamId) return false;
  const team = useTeamsStore.getState().teams.find((t) => t.id === task.teamId);
  if (!team?.leaderId) return false;
  // 与 autoWorker 互斥：任务已被领取（任一通道）则不受理
  if (!claimTask(taskId)) return false;

  try {
    // 1) 受理留痕 + 看板转「进行中」
    await approvals.appendTaskExecutionEvent(taskId, {
      type: 'status',
      content: `收到会话指令：「${instruction.slice(0, 120)}」，leader 开始拆解分派…`,
    });
    await approvals.updateTask(taskId, { status: 'in-progress', workState: 'working' });

    // 2) 注入成员 persona，起编排；任务文本带上追加要求与已有交付，
    //    让成员在现有成果基础上改进，而不是从零重做。
    //    已有交付带足 12000 字（完整上一版），并明确要求保留不变部分——
    //    之前只带 1500 字截断版，成员等于从零重写，返工后内容面目全非。
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

    // sink 增量 append 写回（只追加本轮新增事件），无需预填历史事件列表
    const sink = createThrottledEventSink(taskId);
    // P0-3：里程碑 trace 实时广播到团队房间（失败静默，不影响编排）
    const forwardRoom = createRoomTraceForwarder(team.id);
    // D：编排前拉最新绩效快照（projectRoutingCandidates 注入 performance；失败静默）
    await usePerformanceStore.getState().fetchMemberStats();
    // F：编排前注入团队经验卡（Reflexion 式记忆，arXiv:2303.11366）；无卡/失败 → 不注入
    const experienceText = buildExperienceText(
      await useExperienceStore.getState().getExperience(team.id),
    );
    let orch: Awaited<ReturnType<typeof runSquadOrchestration>>;
    try {
      // C/F 契约字段：qualityMode（双草案高质量模式）+ experience（团队经验卡）
      orch = await runSquadOrchestration({
        taskId,
        taskTitle: task.title,
        taskDescription: [
          task.description,
          `【追加要求（来自会话）】${instruction}`,
          task.workResult
            ? `【上一版交付（在此基础上修订：保留与追加要求无关的部分不变，只改反馈涉及的内容）】\n${task.workResult.slice(0, 12000)}`
            : '',
        ].filter(Boolean).join('\n\n'),
        team,
        candidates: projectRoutingCandidates(team),
        personas,
        maxRounds: 3,
        // C：高优先级任务走双草案高质量模式
        qualityMode: task.priority === 'high',
        // F：团队经验卡文本（最近 10 条，每行「- 内容」）
        ...(experienceText ? { experience: experienceText } : {}),
        // maxTokens 8192：长交付物（动态上限最高 16000 字）需要足够的输出额度，2048 会腰斩。
        chat: (agentId, messages) => runRealChat(messages, 8192, { taskId, teamId: team.id, agentId }),
        onTrace: (t) => { sink.push(t); forwardRoom(t); },
      });
    } finally {
      await sink.flush();
    }

    // D：编排结果按子任务归集成成员绩效上报（fire-and-forget，失败静默）
    void usePerformanceStore.getState().recordOutcomes(subtasksToOutcomes(orch.subtasks));

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

    // 4) 落终态回「待验收」，通知用户验收。
    //    workResult 上限 20000：完整保留汇总交付（动态上限最高 16000 字 + 头尾标注），
    //    看板/会话展示与下次返工的「上一版」上下文都依赖它，4000 会腰斩长报告。
    await approvals.updateTask(taskId, {
      status: 'review',
      workState: 'done',
      ...(deliverableDir ? { deliverableDir } : {}),
      workResult: realOutput.slice(0, 20000),
    });
    notifyTaskTerminal(taskId, 'done', task.title);
    // 5) 交付同步到团队房间：与看板「交付结果」同一份内容，房间里直接可见
    await useTeamsStore
      .getState()
      .appendTeamChatEvent(task.teamId!, {
        from: team.leaderId,
        to: 'user',
        content:
          `「${task.title}」交付完成，请验收：\n\n${realOutput.slice(0, 4000)}` +
          `\n\n> 交付文件在任务会话/看板任务详情里可直接打开或下载 ZIP。`,
      })
      .catch(() => { /* 房间同步失败不阻塞交付 */ });
    // F：交付后 leader 视角复盘一条经验卡（≤150 字，source 记 taskId），
    //    Reflexion 式记忆闭环（arXiv:2303.11366）；失败静默不阻塞交付。
    void reflectExperience({
      teamId: team.id,
      taskId,
      taskTitle: task.title,
      subtasks: orch.subtasks,
      chat: (messages) =>
        runRealChat(messages, 512, { taskId, teamId: team.id, agentId: team.leaderId }),
    });
    return true;
  } catch (err) {
    // 失败复位：workState 落 failed（看板可人工重试），status 回到进入派活前的列——
    // 已有交付（workResult 非空）回 review，否则回 todo，避免任务卡在 in-progress。
    const fresh = useApprovalsStore.getState().tasks.find((t) => t.id === taskId);
    await approvals
      .updateTask(taskId, {
        status: fresh?.workResult ? 'review' : 'todo',
        workState: 'failed',
        workError: `会话派活执行失败：${err instanceof Error ? err.message : String(err)}`,
      })
      .catch(() => {});
    throw err;
  } finally {
    releaseClaim(taskId);
  }
}
