/**
 * src/pages/Kanban/index.tsx
 * 任务看板占位页（TBA / 即将上线）。
 *
 * 背景：全站导航入口（侧栏「任务看板」、全局搜索、Chat「打开看板」按钮、
 * 以及 Chat 创建任务后的深链 `window.location.href='/kanban?taskId=...'`）
 * 已全部指向 /kanban，但真正的拖拽看板尚未实现。本文件仅提供一个优雅的
 * 「即将上线」占位页，消除 /kanban 因路由缺失导致的空白 / 报错，并为后续
 * 全量实现预留接入点。
 *
 * 设计约束（新拟物 Neumorphism，遵循项目记忆中的设计令牌）：
 * - 表面底色使用 var(--neu-surface)（模式感知：白天浅米 / 夜晚浅灰）。
 * - 文字使用墨色分级令牌 var(--neu-ink) / var(--neu-ink-soft)，
 *   禁止使用浅灰 #8e8e93 或 text-gray-*（浅底上对比度不足）。
 * - 容器使用 .glass-panel（凸起）包裹标题与说明，居中布局；
 *   深链提示用 .neu-inset（凹陷）。禁止硬边框、纯黑、直角、hover 放大阴影。
 * - 英文 / 数字标签使用 var(--font-accent)（Space Grotesk）；
 *   不使用 Tailwind 任意值 font-[var(--x)]（实测不生成 CSS）。
 */
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';

/**
 * 任务看板占位页（默认导出）。
 *
 * 处理 Chat 深链：若 URL 携带 ?taskId=，显示一条友好提示，
 * 让 Chat 的「打开看板」深链看起来不是坏链。
 */
export default function Kanban() {
  const { t } = useTranslation('common');
  const [searchParams] = useSearchParams();
  const taskId = searchParams.get('taskId');

  return (
    <div
      className="flex min-h-full w-full items-center justify-center px-6 py-16"
      style={{ backgroundColor: 'var(--neu-surface)' }}
    >
      <section className="glass-panel flex w-full max-w-xl flex-col items-center gap-6 px-8 py-14 text-center">
        {/* 标题区：即将上线徽标 + 页面标题 */}
        <header className="flex flex-col items-center gap-3">
          <span
            className="neu-inset rounded-full px-4 py-1.5 text-[12px] font-medium tracking-wide"
            style={{ fontFamily: 'var(--font-accent)', color: 'var(--neu-ink-soft)' }}
          >
            {t('kanban.comingSoon')}
          </span>
          <h1
            className="text-[26px] font-semibold leading-tight"
            style={{ color: 'var(--neu-ink)' }}
          >
            {t('kanban.title')}
          </h1>
        </header>

        {/* 占位说明 */}
        <p
          className="max-w-md text-[14px] leading-relaxed"
          style={{ color: 'var(--neu-ink-soft)' }}
        >
          {t('kanban.placeholderDesc')}
        </p>

        {/* Chat 深链提示：刚创建的任务将在看板上线后显示 */}
        {taskId ? (
          <div
            className="neu-inset w-full max-w-md rounded-2xl px-5 py-4 text-[13px] leading-relaxed"
            style={{ color: 'var(--neu-ink)' }}
          >
            {t('kanban.taskLinkedHint', { taskId })}
          </div>
        ) : null}
      </section>
    </div>
  );
}
