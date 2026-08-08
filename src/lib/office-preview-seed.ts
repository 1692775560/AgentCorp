/**
 * src/lib/office-preview-seed.ts
 * Web 预览种子数据（仅在 isBrowserPreviewMode() 下注入）。
 *
 * 背景：web 预览没有 Electron 主进程 / gateway，agents 与评估档案的真实来源
 * （/api/agents、electron-store）都拿不到数据，导致人才市集「加载失败」、
 * Agent Office「还没有员工」。本模块在预览模式下给 useAgentsStore 与
 * useEvaluationStore 直接灌入一批合法的种子 agent + 评估档案，使：
 *   - 人才市集有可浏览的 agent；
 *   - 绩效考核有档案；
 *   - Agent Office 按工种自动落座（code→工程部 / image→设计 / text→规划），
 *     且仅 MVP/OBSERVE 入职、FIRED 不入职（与真实规则一致）。
 *
 * 仅前端内存，不落库、不影响 Electron 桌面端真实数据链路。
 */
import type { AgentSummary } from '@/types/agent';
import type {
  EvaluationProfile,
  JobType,
  KpiRecord,
  RadarScore,
  RoiSnapshot,
  Verdict,
  LifecycleState,
} from '@/types/evaluation';
import { useAgentsStore } from '@/stores/agents';
import { useEvaluationStore } from '@/stores/evaluation';

/** 种子人物定义（精简，其余字段由工厂补全）。 */
interface SeedSpec {
  id: string;
  name: string;
  jobType: JobType;
  verdict: Verdict;
  responsibility: string;
  /** 六维基准（0–5），工厂据此生成 radar/kpi/roi */
  base: number;
}

const NOW = new Date().toISOString();

/** verdict → 生命周期状态（FIRED=RETIRED 不入职）。 */
function lifecycleOf(verdict: Verdict): LifecycleState {
  if (verdict === 'FIRED') return 'RETIRED';
  if (verdict === 'MVP') return 'ACTIVE';
  return 'ONBOARDING'; // OBSERVE
}

function makeRadar(base: number): RadarScore {
  const j = (d: number) => Math.max(0.5, Math.min(5, base + d));
  return {
    task: j(0.3),
    quality: j(0.1),
    comm: j(-0.2),
    creativity: j(0.4),
    reliability: j(0),
    cost: j(-0.1),
  };
}

function makeKpi(agentId: string, base: number): KpiRecord {
  const r = base / 5;
  return {
    agentId,
    task_completion_rate: Math.min(1, r + 0.1),
    first_success_rate: Math.min(1, r),
    rework_rate: Math.max(0, 0.3 - r * 0.25),
    avg_delivery_latency_ms: Math.round(9000 - r * 4000),
    autonomy_rate: Math.min(1, r + 0.05),
    escalation_rate: Math.max(0, 0.2 - r * 0.15),
    cross_task_generalization: Math.min(1, r),
    stability_consistency: Math.min(1, r + 0.08),
    sample_n: 12,
    window: '2026-W32',
    computedAt: NOW,
  };
}

function makeRoi(agentId: string, base: number): RoiSnapshot {
  const cps = Math.max(0.5, Math.min(5, base + 0.2));
  return {
    agentId,
    cost_total: 100,
    value_total: 100 + base * 30,
    roi: base * 0.3,
    ipr: 1 + base * 0.3,
    srpc: base / 5,
    cps,
    cost_perf_score: cps,
    roi_index: base * 0.2,
    window: '2026-W32',
  };
}

/** 种子花名册：覆盖三工种、各 verdict，数量充足以填满市集与办公室。 */
const SEEDS: SeedSpec[] = [
  // —— code → 工程部 ——
  { id: 'seed-code-01', name: 'Atlas', jobType: 'code', verdict: 'MVP', responsibility: '后端架构与高并发服务', base: 4.6 },
  { id: 'seed-code-02', name: 'Byte', jobType: 'code', verdict: 'MVP', responsibility: '全栈交付与 CI/CD 自动化', base: 4.3 },
  { id: 'seed-code-03', name: 'Cortex', jobType: 'code', verdict: 'OBSERVE', responsibility: '算法与数据管线', base: 3.6 },
  { id: 'seed-code-04', name: 'Delta', jobType: 'code', verdict: 'OBSERVE', responsibility: '前端工程与性能优化', base: 3.4 },
  { id: 'seed-code-05', name: 'Echo', jobType: 'code', verdict: 'MVP', responsibility: '基础设施与可观测性', base: 4.1 },
  { id: 'seed-code-06', name: 'Flux', jobType: 'code', verdict: 'FIRED', responsibility: '（未通过评估）', base: 2.2 },
  // —— text → 产品规划 ——
  { id: 'seed-text-01', name: 'Muse', jobType: 'text', verdict: 'MVP', responsibility: '产品规划与需求拆解', base: 4.5 },
  { id: 'seed-text-02', name: 'Nova', jobType: 'text', verdict: 'MVP', responsibility: '市场文案与增长叙事', base: 4.2 },
  { id: 'seed-text-03', name: 'Orion', jobType: 'text', verdict: 'OBSERVE', responsibility: '技术写作与文档体系', base: 3.5 },
  { id: 'seed-text-04', name: 'Prose', jobType: 'text', verdict: 'OBSERVE', responsibility: '客服话术与知识库', base: 3.3 },
  { id: 'seed-text-05', name: 'Quill', jobType: 'text', verdict: 'MVP', responsibility: '路线图与优先级决策', base: 4.0 },
  { id: 'seed-text-06', name: 'Rune', jobType: 'text', verdict: 'FIRED', responsibility: '（未通过评估）', base: 2.4 },
  // —— image → 产品设计 ——
  { id: 'seed-img-01', name: 'Sable', jobType: 'image', verdict: 'MVP', responsibility: '视觉设计与品牌系统', base: 4.7 },
  { id: 'seed-img-02', name: 'Terra', jobType: 'image', verdict: 'MVP', responsibility: '产品体验与交互设计', base: 4.4 },
  { id: 'seed-img-03', name: 'Umbra', jobType: 'image', verdict: 'OBSERVE', responsibility: '插画与内容配图', base: 3.7 },
  { id: 'seed-img-04', name: 'Vela', jobType: 'image', verdict: 'OBSERVE', responsibility: '设计系统与组件规范', base: 3.5 },
  { id: 'seed-img-05', name: 'Wisp', jobType: 'image', verdict: 'MVP', responsibility: '动效与原型', base: 4.2 },
  { id: 'seed-img-06', name: 'Xen', jobType: 'image', verdict: 'FIRED', responsibility: '（未通过评估）', base: 2.1 },
];

/** 由种子生成 AgentSummary（补全必填字段）。 */
function toAgentSummary(spec: SeedSpec): AgentSummary {
  return {
    id: spec.id,
    name: spec.name,
    persona: spec.responsibility,
    isDefault: false,
    model: 'minicpm-o',
    modelDisplay: 'MiniCPM-o',
    inheritedModel: true,
    workspace: `~/agents/${spec.id}`,
    agentDir: `/agents/${spec.id}`,
    mainSessionKey: `session-${spec.id}`,
    channelTypes: [],
    avatar: null,
    teamRole: 'worker',
    chatAccess: 'direct',
    responsibility: spec.responsibility,
    reportsTo: null,
    directReports: [],
    lifecycleStatus: spec.verdict === 'FIRED' ? 'maintenance' : 'active',
    source: 'marketplace',
  };
}

/** 由种子生成 EvaluationProfile（合法必填 + jobType + stageScores.verdict）。 */
function toProfile(spec: SeedSpec): EvaluationProfile {
  const radar = makeRadar(spec.base);
  const kpi = makeKpi(spec.id, spec.base);
  const roi = makeRoi(spec.id, spec.base);
  return {
    agentId: spec.id,
    radarLatest: radar,
    radarHistory: [radar],
    kpiLatest: kpi,
    kpiHistory: [kpi],
    roiLatest: roi,
    lifecycle: lifecycleOf(spec.verdict),
    runIds: [],
    updatedAt: NOW,
    jobType: spec.jobType,
    stageScores: [
      {
        agentId: spec.id,
        stage: 'S3',
        jobType: spec.jobType,
        objective: [],
        subjective: {} as never,
        objectiveWeight: 0.6,
        subjectiveWeight: 0.4,
        objectiveScore: spec.base * 20,
        subjectiveScore: spec.base * 18,
        total: spec.base * 19,
        verdict: spec.verdict,
        craftScores: {} as never,
        window: '2026-W32',
        ts: NOW,
      },
    ],
  };
}

let seeded = false;

/** 市集模板视图（与 pages/Marketplace 的 MarketplaceTemplate 结构一致，供预览回退）。 */
export interface PreviewMarketplaceTemplate {
  id: string;
  name: string;
  description: string;
  emoji: string;
  vibe: string;
  role: string;
  hireType: 'single' | 'team';
  capabilities: string[];
  tags: string[];
  price: string;
  avatar: string;
  rating: number;
  hiredCount: number;
}

/** 工种 → 市集标签/角色。 */
const JOB_TAG: Record<JobType, { role: string; tags: string[]; emoji: string; vibe: string }> = {
  code: { role: '工程师', tags: ['代码审查', '数据分析'], emoji: '⚙️', vibe: '严谨高效' },
  text: { role: '产品/文案', tags: ['内容创作', 'SOP', '增长'], emoji: '📝', vibe: '条理清晰' },
  image: { role: '设计师', tags: ['内容创作', '营销'], emoji: '🎨', vibe: '富有创意' },
};

/**
 * Web 预览用市集模板（由同一批种子 agent 生成，使人才市集与 Office 数据一致）。
 * 单个 agent → 雇佣员工(single)；另附三条团队(team)模板填充「雇佣团队」。
 */
export function getPreviewMarketplaceTemplates(): PreviewMarketplaceTemplate[] {
  const singles: PreviewMarketplaceTemplate[] = SEEDS.filter((s) => s.verdict !== 'FIRED').map(
    (s) => {
      const meta = JOB_TAG[s.jobType];
      return {
        id: s.id,
        name: s.name,
        description: s.responsibility,
        emoji: meta.emoji,
        vibe: meta.vibe,
        role: meta.role,
        hireType: 'single' as const,
        capabilities: [s.responsibility],
        tags: meta.tags,
        price: s.verdict === 'MVP' ? '¥399/月' : '¥199/月',
        avatar: meta.emoji,
        rating: Math.round((s.base / 5) * 50) / 10,
        hiredCount: Math.round(s.base * 120),
      };
    },
  );

  const teams: PreviewMarketplaceTemplate[] = [
    {
      id: 'team-eng', name: '工程铁三角', description: '后端 + 全栈 + 基础设施，端到端交付产品',
      emoji: '⚙️', vibe: '稳定可靠', role: '工程团队', hireType: 'team',
      capabilities: ['架构设计', 'CI/CD', '可观测性'], tags: ['代码审查', 'SOP'],
      price: '¥1299/月', avatar: '⚙️', rating: 4.8, hiredCount: 320,
    },
    {
      id: 'team-growth', name: '增长突击队', description: '产品规划 + 文案 + 营销，一条龙做增长',
      emoji: '🚀', vibe: '敏捷进取', role: '增长团队', hireType: 'team',
      capabilities: ['路线图', '增长叙事', '投放'], tags: ['增长', '营销', '内容创作'],
      price: '¥999/月', avatar: '🚀', rating: 4.6, hiredCount: 210,
    },
    {
      id: 'team-design', name: '设计梦之队', description: '视觉 + 交互 + 动效，打造完整体验',
      emoji: '🎨', vibe: '审美在线', role: '设计团队', hireType: 'team',
      capabilities: ['品牌系统', '交互设计', '动效'], tags: ['内容创作', '营销'],
      price: '¥1099/月', avatar: '🎨', rating: 4.7, hiredCount: 180,
    },
  ];

  return [...singles, ...teams];
}

/** 注入种子数据（幂等；仅在 web 预览模式下调用）。 */
export function seedOfficePreviewData(): void {
  if (seeded) return;
  seeded = true;

  const agents = SEEDS.map(toAgentSummary);
  const profiles: Record<string, EvaluationProfile> = {};
  for (const spec of SEEDS) profiles[spec.id] = toProfile(spec);

  // 直接注入两个 store（Zustand setState）。若已有真实数据则不覆盖已存在的键。
  useAgentsStore.setState((state) => ({
    agents: state.agents.length > 0 ? state.agents : agents,
    defaultAgentId: state.defaultAgentId || agents[0]?.id || 'main',
    loading: false,
    error: null,
  }));

  useEvaluationStore.setState((state) => ({
    profiles: Object.keys(state.profiles).length > 0 ? state.profiles : profiles,
    error: null,
  }));

  // 触发一次擂台重算，使绩效榜/市集排序可用（存在则调用）。
  try {
    useEvaluationStore.getState().runLeaderboard();
  } catch {
    /* 容错：无对应实现时忽略 */
  }
}
