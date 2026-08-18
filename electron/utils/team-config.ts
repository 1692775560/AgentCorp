import { readOpenClawConfig, writeOpenClawConfig } from './channel-config';
import { withConfigLock } from './config-mutex';
import { listAgentsSnapshot, writeAgentSoulMd } from './agent-config';
import { listTaskSnapshots } from './task-config';
import { readStoredTeams, writeStoredTeams } from './openclaw-runtime-metadata';
import type { Team, TeamSummary, CreateTeamRequest, UpdateTeamRequest, TeamStatus, TeamChatEvent } from '../../src/types/team';
import { randomUUID } from 'crypto';
import { buildAgentTaskSummaryMap, buildTeamTaskRollupMap } from '../../src/lib/task-summary-read-model';

interface TeamsConfig {
  teams?: Team[];
}

interface ConfigDocument {
  teams?: TeamsConfig;
  [key: string]: unknown;
}

/**
 * Read teams configuration from openclaw.json
 */
export async function readTeamsConfig(): Promise<Team[]> {
  const sidecarTeams = await readStoredTeams();
  if (sidecarTeams.length > 0) {
    return sidecarTeams;
  }

  const config = await readOpenClawConfig() as ConfigDocument;
  const legacyTeams = config.teams?.teams ?? [];
  if (legacyTeams.length > 0) {
    await writeStoredTeams(legacyTeams);
    return legacyTeams;
  }
  return [];
}

/**
 * Write teams configuration to openclaw.json
 */
async function writeTeamsConfig(teams: Team[]): Promise<void> {
  await withConfigLock(async () => {
    await writeStoredTeams(teams);
  });
}

// ── 立项草稿卡协议（与 src/lib/team-task-chat.ts 的 TASK_DRAFT_PREFIX /
// TASK_DRAFT_RESOLUTION_PREFIX 保持一致；electron 构建隔离不能 import src/ 的
// @/ 别名模块，此处内联，改动时请双侧同步）──────────────────────────────────
const TASK_DRAFT_PREFIX = '[task-draft]';
const TASK_DRAFT_RESOLUTION_PREFIX = '[task-draft-resolution]';

/** 房间事件上限：超出时裁最旧。 */
const CHAT_EVENTS_LIMIT = 200;
/** 截断时额外保留的未处置草稿卡上限（防病态累积；超出的最旧未处置卡视为作废、允许裁掉）。 */
const UNRESOLVED_DRAFT_KEEP_LIMIT = 10;

/** 从协议事件 content 中解析 draft id，非协议事件或解析失败返回 null。 */
function parseProtocolDraftId(content: string, prefix: string): string | null {
  if (!content.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(content.slice(prefix.length)) as Record<string, unknown>;
    return typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

/**
 * 房间事件截断到 CHAT_EVENTS_LIMIT：裁最旧，但跳过「未处置」的立项草稿卡
 * （[task-draft] 无对应 [task-draft-resolution]）——一次编排会刷十几条 trace，
 * 待确认的草稿卡被裁掉后老板永远无法确认，派活静默蒸发。
 * 未处置草稿卡最多额外保留 UNRESOLVED_DRAFT_KEEP_LIMIT 张，超出的最旧卡视为作废。
 */
export function truncateChatEvents(events: TeamChatEvent[]): TeamChatEvent[] {
  if (events.length <= CHAT_EVENTS_LIMIT) return events;

  // 已有处置的 draft id 集合（confirmed/cancelled/superseded 都算已处置）
  const resolvedDraftIds = new Set<string>();
  for (const e of events) {
    const id = parseProtocolDraftId(e.content, TASK_DRAFT_RESOLUTION_PREFIX);
    if (id) resolvedDraftIds.add(id);
  }
  const isUnresolvedDraft = (e: TeamChatEvent): boolean => {
    const id = parseProtocolDraftId(e.content, TASK_DRAFT_PREFIX);
    return id !== null && !resolvedDraftIds.has(id);
  };

  // 未处置卡超上限时，最旧的若干张取消豁免资格
  const unresolved = events.filter(isUnresolvedDraft);
  const waivable = new Set(unresolved.slice(0, Math.max(0, unresolved.length - UNRESOLVED_DRAFT_KEEP_LIMIT)));

  const dropCount = events.length - CHAT_EVENTS_LIMIT;
  const kept: TeamChatEvent[] = [];
  let dropped = 0;
  for (const e of events) {
    const droppable = !isUnresolvedDraft(e) || waivable.has(e);
    if (dropped < dropCount && droppable) {
      dropped += 1;
      continue;
    }
    kept.push(e);
  }
  return kept;
}

/**
 * Calculate team status based on member activity
 * Per D-23: active if any member working, blocked if any blocked, else idle
 */
async function calculateTeamStatus(memberIds: string[], leaderId: string): Promise<TeamStatus> {
  const summaries = buildAgentTaskSummaryMap(await listTaskSnapshots());

  let hasActive = false;
  for (const agentId of [leaderId, ...memberIds]) {
    const statusKey = summaries[agentId]?.statusKey;
    // blocked / waiting_approval 都需要人工介入，团队层面统一呈现为 blocked
    if (statusKey === 'blocked' || statusKey === 'waiting_approval') {
      return 'blocked';
    }
    if (statusKey === 'working' || statusKey === 'active') {
      hasActive = true;
    }
  }

  return hasActive ? 'active' : 'idle';
}

/**
 * Generate team name based on leader name
 * Per D-15: "{leaderName} 的团队"
 */
async function generateTeamName(leaderId: string): Promise<string> {
  const snapshot = await listAgentsSnapshot();
  const leader = snapshot.agents.find((a) => a.id === leaderId);

  if (!leader) {
    throw new Error(`Leader agent not found: ${leaderId}`);
  }

  return `${leader.name} 的团队`;
}

/**
 * Build TeamSummary with computed display fields
 */
async function buildTeamSummary(
  team: Team,
  taskRollup?: ReturnType<typeof buildTeamTaskRollupMap>[string],
): Promise<TeamSummary> {
  const snapshot = await listAgentsSnapshot();

  // Find leader
  const leader = snapshot.agents.find((a) => a.id === team.leaderId);
  if (!leader) {
    throw new Error(`Leader agent not found: ${team.leaderId}`);
  }

  // Find members
  const members = team.memberIds
    .map((id) => snapshot.agents.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => a !== undefined);

  // Build member avatars (first 3-4 members)
  const memberAvatars = [leader, ...members].slice(0, 4).map((agent) => ({
    id: agent.id,
    name: agent.name,
    avatar: agent.avatar ?? undefined,
  }));

  // Calculate member count (leader + members)
  const memberCount = 1 + team.memberIds.length;

  const activeTaskCount = taskRollup?.activeTaskCount ?? 0;
  const lastActiveTime = taskRollup?.lastActiveTime;

  return {
    ...team,
    status: taskRollup?.status ?? team.status,
    memberCount,
    activeTaskCount,
    lastActiveTime,
    leaderName: leader.name,
    memberAvatars,
  };
}

/**
 * List all teams with summary information
 */
export async function listTeamsSnapshot(): Promise<TeamSummary[]> {
  const teams = await readTeamsConfig();
  const taskRollups = buildTeamTaskRollupMap(await listTaskSnapshots());

  // Build summaries for all teams
  const summaries = await Promise.all(
    teams.map((team) => buildTeamSummary(team, taskRollups[team.id]))
  );

  // Sort by creation time (newest first, per D-07)
  return summaries.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Create a new team
 * Per D-15: Auto-generate name if not provided
 * Per D-21: Sync updates to agent relationships
 */
export async function createTeam(request: CreateTeamRequest): Promise<TeamSummary> {
  return await withConfigLock(async () => {
    // Validate leader exists
    const snapshot = await listAgentsSnapshot();
    const leader = snapshot.agents.find((a) => a.id === request.leaderId);
    if (!leader) {
      throw new Error(`Leader agent not found: ${request.leaderId}`);
    }

    // Validate all members exist
    for (const memberId of request.memberIds) {
      const member = snapshot.agents.find((a) => a.id === memberId);
      if (!member) {
        throw new Error(`Member agent not found: ${memberId}`);
      }
    }

    // Generate name if not provided
    const name = request.name || await generateTeamName(request.leaderId);

    // Create team
    const now = Date.now();
    const team: Team = {
      id: randomUUID(),
      name,
      leaderId: request.leaderId,
      memberIds: request.memberIds,
      description: request.description || '',
      status: await calculateTeamStatus(request.memberIds, request.leaderId),
      createdAt: now,
      updatedAt: now,
    };

    // Save to config
    const teams = await readTeamsConfig();
    teams.push(team);
    await writeTeamsConfig(teams);

    // Per D-21: Sync reportsTo relationships on agent entries
    const config = await readOpenClawConfig() as ConfigDocument;
    const agentsConfig = (config.agents ?? {}) as Record<string, unknown>;
    const agentList = Array.isArray(agentsConfig.list)
      ? [...(agentsConfig.list as Array<Record<string, unknown>>)]
      : [];

    for (const member of agentList) {
      if (request.memberIds.includes(member.id as string)) {
        member.reportsTo = request.leaderId;
        member.teamRole = 'worker';
      }
      if ((member.id as string) === request.leaderId) {
        member.teamRole = 'leader';
      }
    }

    config.agents = { ...agentsConfig, list: agentList };
    await writeOpenClawConfig(config);

    // Write leader SOUL.md with team member info
    const workers = snapshot.agents.filter(
      (a) => request.memberIds.includes(a.id)
    );
    const leaderSoulContent = [
      `你是「${name}」团队的 Leader。`,
      '',
      '## 团队成员',
      ...workers.map(
        (w) => `- **${w.name}** (${w.id}): ${w.responsibility || '暂无职责描述'}`
      ),
      '',
      '## 管理方式',
      '- 收到任务时，根据成员职责分配给对应 worker',
      '- 使用 sessions_spawn 创建子会话来委派任务',
      '- 汇总 worker 结果后回复用户',
      '',
    ].join('\n');

    await writeAgentSoulMd({
      ...leader,
      persona: leader.persona ? [leader.persona, leaderSoulContent].join('\n\n') : leaderSoulContent,
      teamRole: 'leader',
    });

    // Write SOUL.md for each worker
    for (const memberId of request.memberIds) {
      const worker = snapshot.agents.find((a) => a.id === memberId);
      if (worker) {
        await writeAgentSoulMd({
          ...worker,
          teamRole: 'worker',
          reportsTo: request.leaderId,
        });
      }
    }

    return await buildTeamSummary(team);
  });
}

/**
 * Update an existing team
 */
export async function updateTeam(teamId: string, updates: UpdateTeamRequest): Promise<TeamSummary> {
  return await withConfigLock(async () => {
    const teams = await readTeamsConfig();
    const teamIndex = teams.findIndex((t) => t.id === teamId);

    if (teamIndex === -1) {
      throw new Error(`Team not found: ${teamId}`);
    }

    const team = teams[teamIndex];

    // Validate new members if provided
    if (updates.memberIds) {
      const snapshot = await listAgentsSnapshot();
      for (const memberId of updates.memberIds) {
        const member = snapshot.agents.find((a) => a.id === memberId);
        if (!member) {
          throw new Error(`Member agent not found: ${memberId}`);
        }
      }
    }

    // Apply updates
    const updatedTeam: Team = {
      ...team,
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.description !== undefined && { description: updates.description }),
      ...(updates.memberIds !== undefined && { memberIds: updates.memberIds }),
      // 团队房间聊天记录：整体替换 + 封顶 200 条（裁最旧）
      ...(updates.chatEvents !== undefined && { chatEvents: updates.chatEvents.slice(-200) }),
      updatedAt: Date.now(),
    };

    // Recalculate status if members changed
    if (updates.memberIds !== undefined) {
      updatedTeam.status = await calculateTeamStatus(updatedTeam.memberIds, updatedTeam.leaderId);
    }

    teams[teamIndex] = updatedTeam;
    await writeTeamsConfig(teams);

    // Sync reportsTo relationships if members changed
    if (updates.memberIds !== undefined) {
      const config = await readOpenClawConfig() as ConfigDocument;
      const agentsConfig = (config.agents ?? {}) as Record<string, unknown>;
      const agentList = Array.isArray(agentsConfig.list)
        ? [...(agentsConfig.list as Array<Record<string, unknown>>)]
        : [];

      const removedIds = team.memberIds.filter((id) => !updates.memberIds!.includes(id));
      const addedIds = updates.memberIds!.filter((id) => !team.memberIds.includes(id));

      for (const member of agentList) {
        const memberId = member.id as string;
        // Clear reportsTo for removed members
        if (removedIds.includes(memberId)) {
          delete member.reportsTo;
          delete member.teamRole;
        }
        // Set reportsTo for newly added members
        if (addedIds.includes(memberId)) {
          member.reportsTo = updatedTeam.leaderId;
          member.teamRole = 'worker';
        }
      }

      config.agents = { ...agentsConfig, list: agentList };
      await writeOpenClawConfig(config);

      // Sync SOUL.md for leader (with updated member list)
      const newSnapshot = await listAgentsSnapshot();
      const newWorkers = newSnapshot.agents.filter(
        (a) => updatedTeam.memberIds.includes(a.id)
      );
      const leaderSoulContent = [
        `你是「${updatedTeam.name}」团队的 Leader。`,
        '',
        '## 团队成员',
        ...newWorkers.map(
          (w) => `- **${w.name}** (${w.id}): ${w.responsibility || '暂无职责描述'}`
        ),
        '',
        '## 管理方式',
        '- 收到任务时，根据成员职责分配给对应 worker',
        '- 使用 sessions_spawn 创建子会话来委派任务',
        '- 汇总 worker 结果后回复用户',
        '',
      ].join('\n');
      const leaderAgent = newSnapshot.agents.find((a) => a.id === updatedTeam.leaderId);
      if (leaderAgent) {
        await writeAgentSoulMd({
          ...leaderAgent,
          persona: leaderAgent.persona ? [leaderAgent.persona, leaderSoulContent].join('\n\n') : leaderSoulContent,
          teamRole: 'leader',
        });
      }

      // Rewrite SOUL.md for removed workers (clear team context)
      for (const removedId of removedIds) {
        const removedAgent = newSnapshot.agents.find((a) => a.id === removedId);
        if (removedAgent) {
          await writeAgentSoulMd(removedAgent);
        }
      }

      // Write SOUL.md for newly added workers
      for (const addedId of addedIds) {
        const addedAgent = newSnapshot.agents.find((a) => a.id === addedId);
        if (addedAgent) {
          await writeAgentSoulMd({
            ...addedAgent,
            teamRole: 'worker',
            reportsTo: updatedTeam.leaderId,
          });
        }
      }
    }

    return await buildTeamSummary(updatedTeam);
  });
}

/**
 * Atomically append one chat event to a team's room log.
 *
 * 前端整包读-改-写再 PUT 会在并发广播时丢消息；这里在 withConfigLock 内
 * 读最新 teams → append（补 createdAt、封顶 200 条裁最旧）→ 原子写，
 * 返回更新后的 teams 快照。
 */
export async function appendTeamChatEvent(
  teamId: string,
  input: { from: string; to: string; content: string },
): Promise<Team[]> {
  return await withConfigLock(async () => {
    const teams = await readTeamsConfig();
    const teamIndex = teams.findIndex((t) => t.id === teamId);

    if (teamIndex === -1) {
      throw new Error(`Team not found: ${teamId}`);
    }

    const team = teams[teamIndex];
    const event: TeamChatEvent = {
      from: input.from,
      to: input.to,
      content: input.content,
      createdAt: new Date().toISOString(),
    };

    teams[teamIndex] = {
      ...team,
      chatEvents: truncateChatEvents([...(team.chatEvents ?? []), event]),
      updatedAt: Date.now(),
    };
    await writeTeamsConfig(teams);
    return teams;
  });
}

/**
 * Delete a team
 * Per D-22: Does not delete agents, only removes team relationship
 */
export async function deleteTeam(teamId: string): Promise<void> {
  await withConfigLock(async () => {
    const teams = await readTeamsConfig();
    const team = teams.find((t) => t.id === teamId);
    const filteredTeams = teams.filter((t) => t.id !== teamId);

    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }

    await writeTeamsConfig(filteredTeams);

    // Clear reportsTo and teamRole for former team members
    const config = await readOpenClawConfig() as ConfigDocument;
    const agentsConfig = (config.agents ?? {}) as Record<string, unknown>;
    const agentList = Array.isArray(agentsConfig.list)
      ? [...(agentsConfig.list as Array<Record<string, unknown>>)]
      : [];

    const allMemberIds = [team.leaderId, ...team.memberIds];
    for (const member of agentList) {
      if (allMemberIds.includes(member.id as string)) {
        delete member.reportsTo;
        delete member.teamRole;
      }
    }

    config.agents = { ...agentsConfig, list: agentList };
    await writeOpenClawConfig(config);
  });
}
