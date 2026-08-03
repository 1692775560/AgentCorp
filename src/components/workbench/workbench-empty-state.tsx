import { useState } from 'react';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';

type WorkbenchEmptyStateProps = Record<string, never>;

const quickActions = [
  { label: '解释代码', prompt: '请解释这段代码的作用和原理', skillHints: ['code-assist', 'file-tools'] },
  { label: '写单测', prompt: '为这个函数编写单元测试，覆盖边界情况', skillHints: ['python-env', 'code-assist'] },
  { label: '代码审查', prompt: '请帮我做代码审查，找出潜在的 bug 和改进点', skillHints: ['code-assist'] },
  { label: '优化性能', prompt: '分析并优化这段代码的性能瓶颈', skillHints: ['code-assist', 'terminal'] },
  { label: 'SQL 生成', prompt: '根据以下需求生成对应的 SQL 查询语句：', skillHints: ['file-tools'] },
  { label: '文档生成', prompt: '为这段代码生成清晰的注释和 API 文档', skillHints: ['code-assist', 'file-tools'] },
  { label: 'Git 提交', prompt: '为这段改动生成规范的 commit message', skillHints: ['code-assist'] },
  { label: 'Bug 定位', prompt: '帮我定位并复现这个 bug 的根本原因', skillHints: ['code-assist', 'terminal'] },
];

const suggestions = [
  { icon: '🔧', title: '代码重构方案', description: '提取 src/utils 核心逻辑并编写单测', tag: '重构' },
  { icon: '📊', title: '检查系统健康度', description: '调出监控面板，查昨日定时任务状态', tag: '运维' },
  { icon: '📝', title: '撰写周报汇总', description: '收集近 5 天 Git commit 生成团队周报', tag: '文档' },
  { icon: '🧠', title: '查看团队记忆', description: '总结关于架构设计的长期记忆', tag: '记忆' },
  { icon: '🚀', title: '快速原型', description: '基于需求描述生成可运行的最小可行原型', tag: '原型' },
  { icon: '🔍', title: '依赖审计', description: '扫描 package.json 找过时/有漏洞的依赖', tag: '安全' },
  { icon: '🌐', title: 'API 集成', description: '调用外部 REST API 并做错误处理', tag: '集成' },
  { icon: '🎨', title: 'UI 风格统一', description: '审计组件库，标记偏离设计系统的样式', tag: '设计' },
];

const tips = [
  { icon: '💡', title: '描述具体场景', text: '附上文件路径或代码片段、说明期望结果。' },
  { icon: '🧩', title: '可粘多文件', text: 'Agent 会自动识别依赖与调用关系。' },
  { icon: '⚡', title: '快捷键 ⌘ K', text: '随时唤起命令面板跳转功能。' },
];

export function WorkbenchEmptyState(_props: WorkbenchEmptyStateProps) {
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const isGatewayRunning = useGatewayStore((s) => s.status.state === 'running');
  const [selectedQuickActionIndex, setSelectedQuickActionIndex] = useState(0);
  const [promptPanelOpen, setPromptPanelOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');

  const selectedQuickAction = quickActions[selectedQuickActionIndex] ?? quickActions[0];

  const openPromptPanel = (prompt: string) => {
    if (!isGatewayRunning) return;
    setPromptDraft(prompt);
    setPromptPanelOpen(true);
  };

  const fillComposer = () => {
    setComposerDraft(promptDraft);
    setPromptPanelOpen(false);
  };

  return (
    <div className="flex w-full flex-col gap-5 px-4 pb-10 pt-2 sm:px-8">
      {/* Hero — compact, single line */}
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="relative flex h-14 w-32 items-center justify-center">
          <div className="absolute left-3 top-4 h-7 w-7 rounded-2xl bg-[#dbeafe]" />
          <div className="absolute right-4 top-2 h-8 w-8 rounded-[18px] bg-[#dcfce7]" />
          <div className="absolute bottom-2 left-9 h-6 w-6 rounded-full bg-[#fde68a]" />
          <div
            className="relative flex h-11 w-11 items-center justify-center rounded-2xl text-[20px] text-white"
            style={{
              background: 'linear-gradient(135deg, #10b981, #059669)',
              boxShadow: '0 4px 12px rgba(16, 185, 129, 0.2)',
            }}
          >
            ✦
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <h2 className="text-[20px] font-medium text-foreground">有什么我可以帮你的？</h2>
          {!isGatewayRunning && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-[10.5px] font-medium text-amber-700">
              Gateway 离线 · 启动后可使用全部功能
            </span>
          )}
        </div>
      </div>

      {/* Quick action chips — neumorphic inset tray with raised selected chip */}
      <div className="neu-inset mx-auto w-full max-w-[920px] rounded-2xl px-4 py-3">
        <div className="flex flex-wrap items-center justify-center gap-2">
          {quickActions.map((action, index) => {
            const isSelected = index === selectedQuickActionIndex;
            return (
              <button
                key={action.label}
                type="button"
                aria-label={`Quick action: ${action.label}`}
                aria-pressed={isSelected}
                onClick={() => {
                  setSelectedQuickActionIndex(index);
                  openPromptPanel(action.prompt);
                }}
                disabled={!isGatewayRunning}
                className={`rounded-full px-3.5 py-1.5 text-[12.5px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                  isSelected
                    ? 'neu-btn font-semibold text-[#007aff]'
                    : 'bg-[var(--neu-surface)] text-[#3c3c43] hover:text-[#007aff]'
                }`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Suggestion cards — 4×2 neumorphic grid */}
      <div className="mx-auto grid w-full max-w-[920px] grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            onClick={() => isGatewayRunning && openPromptPanel(suggestion.description)}
            disabled={!isGatewayRunning}
            className="glass group flex flex-col items-start gap-1.5 rounded-2xl p-4 text-left transition-all hover:shadow-[10px_10px_20px_var(--neu-shadow-d),-10px_-10px_20px_var(--neu-shadow-l)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-[18px]">{suggestion.icon}</span>
              <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[10px] font-medium text-[#6b7280]">
                {suggestion.tag}
              </span>
            </div>
            <span className="mt-0.5 text-[13.5px] font-semibold text-foreground">{suggestion.title}</span>
            <p className="text-[11.5px] leading-[1.5] text-[#6b7280]">{suggestion.description}</p>
          </button>
        ))}
      </div>

      {/* Tips footer — 3-column row of compact neumorphic panels */}
      <div className="mx-auto grid w-full max-w-[920px] grid-cols-1 gap-3 sm:grid-cols-3">
        {tips.map((tip) => (
          <div key={tip.title} className="glass flex items-start gap-3 rounded-xl p-3">
            <span className="shrink-0 text-[16px] leading-[1.6]">{tip.icon}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-semibold text-foreground">{tip.title}</p>
              <p className="mt-0.5 text-[11px] leading-[1.5] text-[#6b7280]">{tip.text}</p>
            </div>
          </div>
        ))}
      </div>

      {promptPanelOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 backdrop-blur-sm">
          <div
            role="dialog"
            aria-label="Quick action prompt"
            className="w-full max-w-[560px] rounded-2xl border border-black/[0.08] bg-white p-5 text-left shadow-[0_20px_60px_rgba(0,0,0,0.16)]"
          >
            <div className="mb-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[#6b7280]">Mapped skills</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {(selectedQuickAction.skillHints ?? []).map((hint) => (
                  <span
                    key={hint}
                    className="rounded-full border border-clawx-ac/20 bg-clawx-ac/5 px-3 py-1 text-[12px] font-medium text-clawx-ac"
                  >
                    {hint}
                  </span>
                ))}
              </div>
            </div>

            <div className="mb-4">
              <p className="mb-2 text-[13px] font-medium text-[#111827]">{selectedQuickAction.label}</p>
              <textarea
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
                rows={6}
                className="w-full resize-none rounded-xl border border-black/[0.08] bg-[#f8fafc] px-4 py-3 text-[13px] outline-none focus:border-clawx-ac"
              />
            </div>

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPromptPanelOpen(false)}
                className="rounded-lg border border-black/[0.08] px-3 py-2 text-[13px] text-[#3c3c43] hover:bg-[#f2f2f7]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={fillComposer}
                className="rounded-lg bg-clawx-ac px-3 py-2 text-[13px] font-medium text-white hover:bg-[#005fd6]"
              >
                Fill composer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}