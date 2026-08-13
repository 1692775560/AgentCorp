export type AgentTeamRole = 'leader' | 'worker';
export type AgentChatAccess = 'direct' | 'leader_only';

// 生命周期状态机（小写运行时真相，定义见 src/types/lifecycle.ts）。
// 复用自评估层；AgentSummary.lifecycleStatus 缺省视为 'active'。
// 注意：必须先 import 进本模块作用域再 re-export，
// 单独的 `export type { X } from './lifecycle'` 只做转发，不会把 X 引入本文件作用域，
// 因此下方 AgentSummary.lifecycleStatus 会报 TS2304 找不到名称。
import type { AgentLifecycleStatus } from './lifecycle';

export type { AgentLifecycleStatus };

import type { RoleCard } from '@/engine/agents/roleCard';

/** Agent 来源渠道（由 electron/utils/openclaw-workspace.ts 在快照中下发） */
export type AgentSource = 'marketplace' | 'local' | 'custom';

/** 创建/更新 Agent 时携带的结构化角色卡（G8）。见 src/engine/agents/roleCard.ts。 */
export type AgentRoleCardInput = RoleCard;

export interface AgentSummary {
  id: string;
  name: string;
  persona: string;
  isDefault: boolean;
  model: string;
  modelDisplay: string;
  inheritedModel: boolean;
  workspace: string;
  agentDir: string;
  mainSessionKey: string;
  channelTypes: string[];
  avatar?: string | null;
  teamRole: AgentTeamRole;
  chatAccess: AgentChatAccess;
  responsibility: string;
  reportsTo?: string | null;
  directReports?: string[];
  /**
   * 生命周期状态（运行时真相，见 src/types/lifecycle.ts）。
   * 缺省（未赋值）按 'active' 处理，与 src/stores/agents.ts 的 deriveLifecycleStatus 一致。
   */
  lifecycleStatus?: AgentLifecycleStatus;
  /**
   * Agent 来源渠道。由主进程 electron/utils/openclaw-workspace.ts 写入
   * （实际下发 'marketplace' | 'local'），渲染层缺省按 'custom' 兜底。
   */
  source?: AgentSource;
  /** 结构化角色卡（G8）；缺省时该 Agent 没有规范化角色定义。 */
  roleCard?: RoleCard;
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
}
