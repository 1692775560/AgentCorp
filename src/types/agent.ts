export type AgentTeamRole = 'leader' | 'worker';
export type AgentChatAccess = 'direct' | 'leader_only';

// 生命周期状态机（小写运行时真相，定义见 src/types/lifecycle.ts）。
// 复用自评估层；AgentSummary.lifecycleStatus 缺省视为 'active'。
import type { AgentLifecycleStatus } from './lifecycle';

export type { AgentLifecycleStatus };

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
  /** 来源标记（TeamOverview 人力资产徽章用）；缺省由调用方按 'local'/'custom' 兜底。 */
  source?: 'marketplace' | 'local' | 'custom';
}

export interface AgentsSnapshot {
  agents: AgentSummary[];
  defaultAgentId: string;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
}
