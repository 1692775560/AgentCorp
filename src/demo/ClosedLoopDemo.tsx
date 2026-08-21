/**
 * 多 Agent 闭环演示页（web 预览 5174 可用，路径 /demo.html）。
 * 展示 boss → recruiter → evaluator → boss 端到端闭环，每一步对齐八步闭环阶段。
 *
 * 本页不直连 runClosedLoop——而是走 AgentTeams 薄适配：
 *   createTeam() → createTask() → runTask(team, task)
 * runTask 内部经 invokeSkill 逐阶段调用 Skill（recruiter→agent_interview、
 * evaluator→capability_assessment/reliability_audit、boss→boss_review），
 * 步骤面板直接展示 run.steps 的「Agent → Skill」调用链（Skill 真实调用证据）。
 * 评委默认走 demoJudge（真实网关可达用真评委，否则降级 mock，闭环永不中断）。
 */
import { useEffect, useState } from 'react';
import { ROLE_CARDS } from '@/engine/agents/roleCard';
import {
  createTeam,
  createTask,
  runTask,
  getHireLedger,
  applyHire,
  revokeHire,
  type ATRun,
} from './agentteams-adapter';
import { phaseLabel, type ClosedLoopResult, type LoopStep } from './closedLoop';
import {
  sinkRun,
  replayRun,
  listRunIds,
  setTraceBackend,
  createLocalStorageBackend,
  downloadRunJsonl,
} from './observability/traceSink';
import {
  setExperiencePersister,
  createLocalStorageExperiencePersister,
} from './skills/experienceStore';
import {
  decideApproval,
  exportAuditJsonl,
  setApprovalPersister,
  createLocalStorageApprovalPersister,
} from '../engine/governance/approvalGate';
import { RADAR_DIMS } from '@/engine/scoring/registry';

const SAMPLE = {
  requirement: '招聘一名能独立承担前端组件库开发的 Agent 工程师，要求稳定可靠、沟通清晰。',
  candidateName: 'FrontendAgent-07',
  candidatePersona:
    '我是一名前端组件库 Agent，擅长 React/TS 组件拆分与无障碍实现，习惯先复述需求再动手，遇到歧义会主动追问。',
  transcript:
    '面试官：请描述你如何把一个大型表单拆成可控组件。\n候选：我会先复述需求——表单需支持分步校验与错误聚合。然后按职责拆为 FormProvider（状态）、Field（受控单元）、Validator（纯函数校验）、ErrorSummary（聚合展示）。每步我会先给最小可用版本再增强。\n面试官：如果校验规则频繁变化怎么办？\n候选：我会把规则抽成配置驱动，并用纯函数 Validator 便于单测；变更时只改配置不改组件，并保留回滚点。',
};

const actionColor: Record<string, string> = {
  hire: '#2e7d32',
  observe: '#ef6c00',
  reject: '#c62828',
  rollback: '#6a1b9a',
};

export default function ClosedLoopDemo() {
  const [req, setReq] = useState({ ...SAMPLE, candidateId: 'fe-agent-07' });
  const [run, setRun] = useState<ATRun | null>(null);
  const [running, setRunning] = useState(false);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [replayId, setReplayId] = useState('');
  const [decisionNote, setDecisionNote] = useState('');
  const [auditLines, setAuditLines] = useState<string[]>([]);
  const [hireLedgerCount, setHireLedgerCount] = useState(0);

  // web demo 的 Trace 落盘后端 = localStorage（内存兜底）
  // 经验沉淀同样落 localStorage——否则刷新页面即丢，
  // 「沉淀 → 下一轮复用注入」的回路在演示现场无法被验证。
  useEffect(() => {
    setTraceBackend(createLocalStorageBackend());
    setExperiencePersister(createLocalStorageExperiencePersister());
    setApprovalPersister(createLocalStorageApprovalPersister());
    setSavedIds(listRunIds());
  }, []);

  const result: ClosedLoopResult | null = run?.result ?? null;

  const start = async () => {
    setRunning(true);
    try {
      // AgentTeams 形态：Team → Task → Run（内部经 invokeSkill 调 Skill）
      const team = createTeam();
      const task = createTask({
        title: req.requirement.slice(0, 30),
        requirement: req.requirement,
        candidateId: req.candidateId,
        candidateName: req.candidateName,
        transcript: req.transcript,
      });
      const r = await runTask(team, task);
      setRun(r);
      sinkRun(r); // 每次 run 自动落盘（localStorage JSONL）
      setSavedIds(listRunIds());
      setDecisionNote('');
      setAuditLines(exportAuditJsonl(r.runId));
      setHireLedgerCount(getHireLedger().length);
    } finally {
      setRunning(false);
    }
  };

  const replay = () => {
    const r = replayId ? replayRun(replayId) : null;
    if (r) setRun(r);
  };

  /**
   * 人工决策：approve 时才真正执行受管动作（写录用台账），reject 则动作永不执行。
   * 这里重建受管动作以模拟生产环境「按 approvalId 从动作注册表取回」的行为。
   */
  const decide = async (decision: 'approve' | 'reject') => {
    if (!run?.pendingApprovalId || !result) return;
    const candidateId = result.request.candidateId;
    const candidateName = result.request.candidateName;
    const out = await decideApproval(
      run.pendingApprovalId,
      decision,
      'human:demo-operator',
      decision === 'approve' ? '演示：人工复核通过，同意执行' : '演示：人工拒绝，动作不执行',
      {
        apply: () => {
          if (decision === 'approve') applyHire(candidateId, candidateName);
          return decision;
        },
        compensate: () => revokeHire(candidateId),
        compensateDescription: `从录用台账移除 ${candidateName}`,
      },
    );
    setDecisionNote(
      out.ok
        ? `✅ 决策已记录：${out.state}。${decision === 'approve' ? '动作此刻才被执行。' : '动作未执行，且永不执行。'}`
        : `⚠️ 决策未生效：${out.reason}`,
    );
    setHireLedgerCount(getHireLedger().length);
    setAuditLines(exportAuditJsonl(run.runId));
    setRun({ ...run, status: decision === 'approve' ? 'completed' : 'failed' });
  };

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif', color: '#1a1c1e' }}>
      <h1 style={{ fontSize: 24, marginBottom: 4 }}>AgentCorp · 多 Agent 闭环 Demo</h1>
      <p style={{ color: '#555', marginTop: 0 }}>
        数字员工招募与管理训练场 · AgentTeams 协同基点（Team→Task→Run→invokeSkill）·
        八步闭环：任务输入→拆解→上下文→工具→验证→证据→审批→经验
      </p>

      <h2 style={{ fontSize: 18, marginTop: 24 }}>Agent Identity 清单（4 异构职能 Agent）</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(220px,1fr))', gap: 12 }}>
        {ROLE_CARDS.map((c) => (
          <div key={c.id} style={{ border: '1px solid #ddd', borderRadius: 10, padding: 12, background: '#fafafa' }}>
            <div style={{ fontWeight: 700 }}>{c.name}</div>
            <div style={{ fontSize: 12, color: '#777', margin: '2px 0 6px' }}>{c.role} · {c.teamRole}</div>
            <div style={{ fontSize: 13 }}>{c.goal}</div>
            <div style={{ fontSize: 12, marginTop: 8, color: c.boundaries.riskLevel === 'high' ? '#c62828' : '#555' }}>
              边界风险：{c.boundaries.riskLevel}{c.boundaries.requiresApproval ? ' · 需审批' : ''}
            </div>
            <div style={{ fontSize: 12, marginTop: 4, color: '#3b82f6' }}>
              Skills：{c.skills.map((s) => s.id).join(' / ')}
            </div>
          </div>
        ))}
      </div>

      <h2 style={{ fontSize: 18, marginTop: 24 }}>招聘需求 & 候选上下文</h2>
      <label style={labelStyle}>任务输入（boss 需求）</label>
      <textarea style={taStyle} value={req.requirement} onChange={(e) => setReq({ ...req, requirement: e.target.value })} />
      <label style={labelStyle}>候选 Agent 名称</label>
      <input style={inputStyle} value={req.candidateName} onChange={(e) => setReq({ ...req, candidateName: e.target.value })} />
      <label style={labelStyle}>候选 persona</label>
      <textarea style={taStyle} value={req.candidatePersona} onChange={(e) => setReq({ ...req, candidatePersona: e.target.value })} />
      <label style={labelStyle}>面试转录（recruiter 产出，交接 evaluator）</label>
      <textarea style={taStyle} value={req.transcript} onChange={(e) => setReq({ ...req, transcript: e.target.value })} />

      <button onClick={start} disabled={running} style={{ marginTop: 12, padding: '10px 18px', fontSize: 15, borderRadius: 8, border: 'none', background: '#1a1c1e', color: '#fff', cursor: running ? 'default' : 'pointer' }}>
        {running ? '运行中…' : '▶ 运行 AgentTeams 闭环（Team→Task→Run）'}
      </button>

      {/* Trace 落盘下载 + 历史 run 回放 */}
      <div style={{ marginTop: 10, fontSize: 13, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => run && downloadRunJsonl(run)}
          disabled={!run}
          style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: run ? 'pointer' : 'default' }}
        >
          💾 保存本次 Trace（run-*.jsonl）
        </button>
        {savedIds.length > 0 && (
          <>
            <span style={{ color: '#555' }}>回放历史 run：</span>
            <select value={replayId} onChange={(e) => setReplayId(e.target.value)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #ccc', maxWidth: 360 }}>
              <option value="">选择 trace…</option>
              {savedIds.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
            <button
              onClick={replay}
              disabled={!replayId}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #ccc', background: '#fff', cursor: replayId ? 'pointer' : 'default' }}
            >
              ⏪ 回放
            </button>
          </>
        )}
      </div>

      {run && result && (
        <div style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 18 }}>闭环结果（Run {run.runId} · {run.status}）</h2>

          {/* 审批门：高风险动作被拦下时，闭环挂起，动作未执行，等待人工放行 */}
          {run.status === 'awaiting_approval' && run.pendingApprovalId && (
            <div style={{ marginTop: 12, padding: 14, border: '2px solid #ef6c00', borderRadius: 10, background: '#fff8e1' }}>
              <div style={{ fontWeight: 700, color: '#e65100', fontSize: 15 }}>
                ⛔ 高风险动作已被审批门拦截 —— 动作尚未执行
              </div>
              <div style={{ fontSize: 13, marginTop: 6, color: '#5d4037' }}>
                审批单 <code>{run.pendingApprovalId}</code>·
                录用台账当前记录数：<b>{hireLedgerCount}</b>（放行前应为 0）
              </div>
              <div style={{ marginTop: 10, display: 'flex', gap: 10 }}>
                <button onClick={() => void decide('approve')} style={approveBtn}>
                  ✅ 人工放行（执行动作）
                </button>
                <button onClick={() => void decide('reject')} style={rejectBtn}>
                  ✋ 拒绝（动作永不执行）
                </button>
              </div>
            </div>
          )}

          {decisionNote && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#e8f5e9', fontSize: 13, color: '#1b5e20' }}>
              {decisionNote}
            </div>
          )}

          {auditLines.length > 0 && (
            <Section title="⓪ 审批审计流水（每次状态跃迁留痕，可导出 JSONL）">
              {auditLines.map((l, i) => (
                <div key={i} style={{ fontSize: 11, fontFamily: 'monospace', padding: '2px 0', borderBottom: '1px dashed #eee', wordBreak: 'break-all' }}>
                  {l}
                </div>
              ))}
            </Section>
          )}

          <Section title="① 编排计划（dispatcher 拆解）">
            <div style={{ fontSize: 13 }}>目标维度：{result.plan.targetDims.join(' / ')}</div>
            <ol style={{ fontSize: 13, margin: '4px 0' }}>{result.plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          </Section>

          <Section title="② 评估中心结论（evaluator · capability_assessment + reliability_audit）">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              {RADAR_DIMS.map((d) => {
                const v = result.evaluation.meanRadar[d] ?? 0;
                return (
                  <div key={d} style={{ width: 150 }}>
                    <div style={{ fontSize: 12 }}>{d}：{v}</div>
                    <div style={{ height: 8, background: '#eee', borderRadius: 4 }}>
                      <div style={{ height: 8, width: `${(v / 5) * 100}%`, background: '#3b82f6', borderRadius: 4 }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 13, marginTop: 8 }}>
              判定：<b>{result.evaluation.verdict}</b> · 置信度：{result.evaluation.confidence} · 来源：{result.evaluation.source}
            </div>
            <div style={{ fontSize: 13 }}>
              pass^k：allPass={String(result.evaluation.passK.allPass)} · passRate={result.evaluation.passK.passRate} · k={result.evaluation.passK.k}
            </div>
            <div style={{ fontSize: 13, color: result.evaluation.biasAudit.unstable ? '#c62828' : '#555' }}>
              偏差审计：unstable={String(result.evaluation.biasAudit.unstable)} · maxSpread={result.evaluation.biasAudit.maxSpread}
            </div>
          </Section>

          <Section title="③ 老板拍板（boss_review Skill · 高风险需人工确认）">
            <div style={{ fontSize: 15, fontWeight: 700, color: actionColor[result.bossDecision.action] }}>
              {result.bossDecision.action.toUpperCase()}
            </div>
            <div style={{ fontSize: 13 }}>{result.bossDecision.reason}</div>
            <div style={{ fontSize: 12, color: '#777' }}>
              需人工确认：{String(result.bossDecision.requiresHumanAck)} · 决策来源：{result.bossDecision.source}
            </div>
          </Section>

          <Section title="④ 经验沉淀（boss_review 产出 · 结构化可复用规则）">
            <div style={{ fontSize: 13 }}>{result.experience}</div>
            <div style={{ fontSize: 12, color: '#555', marginTop: 6 }}>
              最弱维（训练重点）：<b>{result.precipitatedRule.weakestDim}</b> ·
              最强维（复用价值）：<b>{result.precipitatedRule.strongestDim}</b> ·
              来源：{result.precipitatedRule.source}
            </div>
          </Section>

          <Section title="⑤ 全链路执行轨迹（evidence · Agent→Skill 调用链 Trace）">
            {run.steps.map((s, i) => (
              <div key={i} style={{ fontSize: 12, padding: '4px 0', borderBottom: '1px dashed #eee' }}>
                <span style={{ color: '#3b82f6', fontWeight: 600 }}>[{phaseLabel[s.phase as LoopStep['phase']] ?? s.phase}]</span>{' '}
                <span style={{ color: '#555' }}>{s.agent}</span>
                {s.skill && <span style={{ color: '#6a1b9a', fontWeight: 600 }}> →⚙ {s.skill}</span>}
                {'：'}{s.summary}
              </div>
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, marginTop: 12, fontWeight: 600 };
const taStyle: React.CSSProperties = { width: '100%', minHeight: 64, marginTop: 4, padding: 8, borderRadius: 6, border: '1px solid #ccc', fontFamily: 'inherit' };
const approveBtn: React.CSSProperties = { padding: '8px 16px', borderRadius: 6, border: 'none', background: '#2e7d32', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 };
const rejectBtn: React.CSSProperties = { padding: '8px 16px', borderRadius: 6, border: '1px solid #c62828', background: '#fff', color: '#c62828', cursor: 'pointer', fontSize: 14, fontWeight: 600 };
const inputStyle: React.CSSProperties = { width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ccc', fontFamily: 'inherit' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 10, padding: 12, marginTop: 12, background: '#fff' }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
