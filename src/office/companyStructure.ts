/**
 * companyStructure.ts — AgentCorp org model + A2A (Google Agent2Agent) protocol data.
 *
 * This is the data layer behind the clickable department panels. It describes:
 *   1. The company hierarchy (C-Suite → department → roles), top to bottom.
 *   2. Each department's charge / mandate.
 *   3. The A2A collaboration protocol used between agents — modelled on
 *      Google's Agent2Agent standard: every agent publishes an **Agent Card**
 *      (skills + capabilities), work flows as **Tasks** delegated peer-to-peer,
 *      and results come back as **Artifacts**.
 *
 * The org tree is static scaffolding; live agents (from OpenClaw / Claude Code)
 * are matched onto department roles at render time by their `area` label.
 */

// ── Company hierarchy ───────────────────────────────────────────────────────────

/** A node in the top-down org tree. */
export interface OrgNode {
  /** Title of the role, e.g. "CTO", "Engineering Lead". */
  title: string;
  /** Optional human-ish codename shown under the title. */
  codename?: string;
  /** Seniority tier — drives indentation & styling in the tree view. */
  tier: 'exec' | 'lead' | 'ic';
  /** Child roles reporting to this node. */
  reports?: OrgNode[];
}

/** A2A skill entry inside an Agent Card (Google Agent2Agent style). */
export interface A2ASkill {
  id: string;
  name: string;
  description: string;
}

/** Simplified A2A Agent Card — what an agent advertises to peers. */
export interface AgentCard {
  /** Role/title this card belongs to. */
  role: string;
  /** Protocol version — we track Google A2A. */
  protocol: 'google-a2a/1.0';
  /** Capability flags per the A2A spec. */
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  /** Advertised skills (discoverable by other agents). */
  skills: A2ASkill[];
  /** Input / output content types the agent accepts (A2A modalities). */
  defaultInputModes: string[];
  defaultOutputModes: string[];
}

/** A delegated A2A Task edge: department → department (or role → role). */
export interface A2ATask {
  /** Who delegates the task. */
  from: string;
  /** Who receives it. */
  to: string;
  /** Human summary of the delegated work. */
  intent: string;
  /** A2A task lifecycle state. */
  state: 'submitted' | 'working' | 'input-required' | 'completed';
  /** Artifact produced/expected on completion. */
  artifact: string;
}

/** Everything a department panel needs to render. */
export interface DepartmentInfo {
  /** Area label — must match the layout's area labels exactly. */
  label: string;
  /** 中文显示名（芯片 / 面板使用，避免浏览器把英文 label 误翻译）。 */
  nameZh: string;
  /** Short mandate shown at the top of the panel. */
  charge: string;
  /** Accent colour (matches the layout area colour). */
  color: string;
  /** Emoji/glyph used on the floating chip. */
  glyph: string;
  /** Top-down role tree for this department. */
  org: OrgNode;
  /** The A2A Agent Card the department's lead publishes. */
  agentCard: AgentCard;
  /** Outgoing A2A task delegations to other departments. */
  a2aTasks: A2ATask[];
}

// ── Shared C-suite context (top of company) ─────────────────────────────────────

export const C_SUITE: OrgNode = {
  title: 'CEO — Orchestrator',
  codename: 'AgentCorp Command',
  tier: 'exec',
  reports: [
    { title: 'CTO', codename: 'Engineering & QA', tier: 'exec' },
    { title: 'CPO', codename: 'Product & Design', tier: 'exec' },
    { title: 'COO', codename: 'Operations & Finance', tier: 'exec' },
  ],
};

// ── Per-department definitions ──────────────────────────────────────────────────

function card(role: string, skills: A2ASkill[], modes: string[] = ['text', 'application/json']): AgentCard {
  return {
    role,
    protocol: 'google-a2a/1.0',
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: true },
    skills,
    defaultInputModes: modes,
    defaultOutputModes: modes,
  };
}

export const DEPARTMENTS: Record<string, DepartmentInfo> = {
  Engineering: {
    label: 'Engineering',
    nameZh: '工程部',
    charge: 'Build and ship the core product. Owns the codebase, architecture, and delivery.',
    color: '#3b82f6',
    glyph: '⚙',
    org: {
      title: 'CTO', tier: 'exec', reports: [
        { title: 'Engineering Lead', codename: 'Backend', tier: 'lead', reports: [
          { title: 'Senior Engineer', tier: 'ic' },
          { title: 'Engineer', tier: 'ic' },
        ]},
        { title: 'Frontend Lead', tier: 'lead', reports: [
          { title: 'UI Engineer', tier: 'ic' },
        ]},
      ],
    },
    agentCard: card('Engineering Lead', [
      { id: 'code.write', name: 'Write Code', description: 'Implement features across the stack.' },
      { id: 'code.review', name: 'Review Code', description: 'Review PRs and enforce standards.' },
      { id: 'arch.design', name: 'Design Architecture', description: 'Propose system designs.' },
    ]),
    a2aTasks: [
      { from: 'Engineering', to: 'QA', intent: 'Verify the new auth flow', state: 'working', artifact: 'test-report.json' },
      { from: 'Engineering', to: 'Design', intent: 'Confirm final button states', state: 'input-required', artifact: 'ui-spec.md' },
    ],
  },

  QA: {
    label: 'QA',
    nameZh: '质量保证',
    charge: 'Guard quality. Owns test strategy, regression coverage, and release sign-off.',
    color: '#22c55e',
    glyph: '✓',
    org: {
      title: 'QA Lead', tier: 'lead', reports: [
        { title: 'Automation Engineer', tier: 'ic' },
        { title: 'Manual Tester', tier: 'ic' },
      ],
    },
    agentCard: card('QA Lead', [
      { id: 'test.run', name: 'Run Test Suite', description: 'Execute regression + e2e suites.' },
      { id: 'test.report', name: 'Report Defects', description: 'File and triage defects.' },
    ]),
    a2aTasks: [
      { from: 'QA', to: 'Engineering', intent: 'Return failing test artifacts', state: 'completed', artifact: 'defects.json' },
    ],
  },

  Design: {
    label: 'Design',
    nameZh: '产品设计',
    charge: 'Own the product experience — flows, visuals, and design-system consistency.',
    color: '#a855f7',
    glyph: '✎',
    org: {
      title: 'CPO', tier: 'exec', reports: [
        { title: 'Design Lead', tier: 'lead', reports: [
          { title: 'Product Designer', tier: 'ic' },
          { title: 'UX Researcher', tier: 'ic' },
        ]},
      ],
    },
    agentCard: card('Design Lead', [
      { id: 'design.flow', name: 'Design Flows', description: 'Produce end-to-end UX flows.' },
      { id: 'design.spec', name: 'Write UI Specs', description: 'Deliver implementation-ready specs.' },
    ], ['text', 'image/png', 'application/json']),
    a2aTasks: [
      { from: 'Design', to: 'Engineering', intent: 'Handoff UI spec for auth screen', state: 'submitted', artifact: 'ui-spec.md' },
    ],
  },

  PM: {
    label: 'PM',
    nameZh: '产品规划',
    charge: 'Set direction and priorities. Turns strategy into a sequenced roadmap.',
    color: '#f97316',
    glyph: '◎',
    org: {
      title: 'Head of Product', tier: 'exec', reports: [
        { title: 'Product Manager', tier: 'lead', reports: [
          { title: 'Associate PM', tier: 'ic' },
        ]},
      ],
    },
    agentCard: card('Product Manager', [
      { id: 'roadmap.plan', name: 'Plan Roadmap', description: 'Sequence and prioritise work.' },
      { id: 'spec.write', name: 'Write PRDs', description: 'Author product requirement docs.' },
    ]),
    a2aTasks: [
      { from: 'PM', to: 'Engineering', intent: 'Kick off Q3 auth epic', state: 'working', artifact: 'prd.md' },
      { from: 'PM', to: 'Design', intent: 'Request flow exploration', state: 'submitted', artifact: 'brief.md' },
    ],
  },

  Operations: {
    label: 'Operations',
    nameZh: '运维部',
    charge: 'Keep the lights on. Owns infra, deployments, reliability, and incident response.',
    color: '#ef4444',
    glyph: '⛭',
    org: {
      title: 'COO', tier: 'exec', reports: [
        { title: 'Ops Lead', tier: 'lead', reports: [
          { title: 'SRE', tier: 'ic' },
          { title: 'DevOps Engineer', tier: 'ic' },
        ]},
      ],
    },
    agentCard: card('Ops Lead', [
      { id: 'deploy.run', name: 'Deploy', description: 'Ship builds to environments.' },
      { id: 'incident.handle', name: 'Handle Incidents', description: 'Respond to and resolve incidents.' },
    ]),
    a2aTasks: [
      { from: 'Operations', to: 'Engineering', intent: 'Escalate prod error spike', state: 'input-required', artifact: 'incident.json' },
    ],
  },

  Finance: {
    label: 'Finance',
    nameZh: '财务室',
    charge: 'Small back office. Tracks spend, budgets, and cost of compute across teams.',
    color: '#10b981',
    glyph: '$',
    org: {
      title: 'Finance Lead', tier: 'lead', reports: [
        { title: 'Accountant', tier: 'ic' },
      ],
    },
    agentCard: card('Finance Lead', [
      { id: 'budget.track', name: 'Track Budget', description: 'Monitor spend vs. budget.' },
      { id: 'cost.report', name: 'Report Costs', description: 'Produce compute-cost reports.' },
    ]),
    a2aTasks: [
      { from: 'Finance', to: 'Operations', intent: 'Request monthly compute usage', state: 'completed', artifact: 'usage.csv' },
    ],
  },

  Lobby: {
    label: 'Lobby',
    nameZh: '大厅',
    charge: 'Reception & intake. Where new tasks and external requests first arrive.',
    color: '#f59e0b',
    glyph: '⌂',
    org: {
      title: 'Reception', tier: 'lead', reports: [
        { title: 'Intake Coordinator', tier: 'ic' },
      ],
    },
    agentCard: card('Reception', [
      { id: 'intake.route', name: 'Route Requests', description: 'Triage incoming requests to teams.' },
    ]),
    a2aTasks: [
      { from: 'Lobby', to: 'PM', intent: 'Forward new feature request', state: 'submitted', artifact: 'request.md' },
    ],
  },

  'Meeting Room': {
    label: 'Meeting Room',
    nameZh: '会议室',
    charge: 'Decision-making space. Cross-team syncs and leadership calls happen here.',
    color: '#06b6d4',
    glyph: '⚑',
    org: {
      title: 'Chair (rotating)', tier: 'exec', reports: [
        { title: 'Dept Leads (all)', tier: 'lead' },
      ],
    },
    agentCard: card('Meeting Facilitator', [
      { id: 'decision.record', name: 'Record Decisions', description: 'Capture and broadcast decisions.' },
      { id: 'sync.coordinate', name: 'Coordinate Syncs', description: 'Align cross-team dependencies.' },
    ]),
    a2aTasks: [
      { from: 'Meeting Room', to: 'Engineering', intent: 'Broadcast: adopt A2A for handoffs', state: 'completed', artifact: 'decision-log.md' },
      { from: 'Meeting Room', to: 'PM', intent: 'Approve Q3 roadmap', state: 'working', artifact: 'decision-log.md' },
    ],
  },
};

/** Ordered list of department labels for stable iteration. */
export const DEPARTMENT_LABELS = Object.keys(DEPARTMENTS);

/** Look up a department by its area label (safe). */
export function getDepartment(label: string): DepartmentInfo | undefined {
  return DEPARTMENTS[label];
}

/** Human-readable label for an A2A task state. */
export const A2A_STATE_LABEL: Record<A2ATask['state'], string> = {
  submitted: 'Submitted',
  working: 'Working',
  'input-required': 'Input Required',
  completed: 'Completed',
};

/** Colour for an A2A task state. */
export const A2A_STATE_COLOR: Record<A2ATask['state'], string> = {
  submitted: '#60a5fa',
  working: '#fbbf24',
  'input-required': '#f472b6',
  completed: '#34d399',
};
