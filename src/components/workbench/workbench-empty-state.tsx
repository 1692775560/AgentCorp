import { useGatewayStore } from '@/stores/gateway';

type WorkbenchEmptyStateProps = Record<string, never>;

/**
 * 三大核心功能 —— 仅作「思想表达」，不重复左侧功能菜单的罗列。
 * 当前产品尚未落地对应路由，故以极简文字呈现，非交互。
 * 用最简中文词表达，避免英文 caption 与解释性 tagline 造成的视觉冗杂。
 */
const CORE_FUNCTIONS = ['招募', '面试', '考评'] as const;

export function WorkbenchEmptyState(_props: WorkbenchEmptyStateProps) {
  const isGatewayRunning = useGatewayStore((s) => s.status.state === 'running');

  return (
    <div className="flex min-h-full w-full flex-col justify-center gap-10 px-4 py-12 sm:px-8">
      {/* 上方 · 主问候 */}
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="glass flex h-12 w-12 items-center justify-center rounded-2xl text-[22px] text-[var(--neu-ink)]">
          ✦
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <h2 className="text-[26px] font-medium tracking-tight text-foreground sm:text-[30px]">
            有什么我可以帮你的？
          </h2>
          {!isGatewayRunning && (
            <span className="neu-inset rounded-full px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
              Gateway 离线 · 启动后可使用全部功能
            </span>
          )}
        </div>
      </div>

      {/* 中间 · 产品理念（三层，极简） */}
      <div className="mx-auto flex w-full max-w-[760px] flex-col items-center text-center">
        {/* 主标语：中文手写体（ZCOOL XiaoWei），放大字号、收紧行高，成为品牌视觉焦点。
         * 用内联 style 指定 font-family，规避 Tailwind 任意值 font-[var(...)] 不生成 CSS 的坑。 */}
        <p
          style={{ fontFamily: 'var(--font-display)' }}
          className="text-[46px] leading-[1.06] tracking-tight text-[var(--neu-ink)] sm:text-[60px]"
        >
          不追最强，只找最配
        </p>

        {/* 三核心功能：极简中文词，用圆点分隔，无英文、无解释，弱化呈现。 */}
        <div className="mt-6 flex items-center gap-3 text-[15px] font-medium tracking-wide text-[var(--neu-ink)]">
          {CORE_FUNCTIONS.map((name, index) => (
            <span key={name} className="flex items-center gap-3">
              {index > 0 && (
                <span aria-hidden="true" className="text-[var(--neu-ink-soft)]/50">
                  ·
                </span>
              )}
              <span>{name}</span>
            </span>
          ))}
        </div>

        {/* 哲学句：核心价值观「金句牌」——手写体 + 主墨色 + 凸起 pill，与主标语同品牌字体形成呼应，
         * 明显比从前（13px 软墨凹陷 pill）更突出，但又弱于 46/60px 主标语，形成
         * 「主标语 → 三核心词 → 金句」的三段呼吸感。凸起用 .glass-sm 增加存在感，
         * 用内联 style 指定 font-family，规避 Tailwind 任意值 font-[var(...)] 不生成 CSS 的坑。 */}
        <p className="mt-8">
          <span
            style={{ fontFamily: 'var(--font-display)' }}
            className="glass-sm inline-block rounded-full px-7 py-2.5 text-[17px] font-medium tracking-[0.06em] text-[var(--neu-ink)] sm:text-[19px]"
          >
            合拍，比满分更重要。
          </span>
        </p>
      </div>
    </div>
  );
}
