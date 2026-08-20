/**
 * src/components/onboarding/FirstRunGuide.tsx
 * 新手引导：交互式清单，带用户「跟着做一遍」完整业务闭环。
 *
 * 与 pages/Setup 的分工：Setup 解决「环境能不能跑」（runtime / provider），
 * 本组件解决「进来该干什么」—— 认识员工 → 组队 → 派团队任务 → 验收交付。
 *
 * 交互方式：
 * - 每步带「去做」按钮跳到对应页面；步骤完成与否由 store 状态自动判定
 *   （见 guideProgress.ts），满足条件自动打勾，无需手动确认。
 * - 全部完成后展示完成态并自动收起，同时写入 onboardingSeen（localStorage 持久化），
 *   之后不再自动弹出；可从侧边栏「新手引导」随时重看（guideOpen，不持久化）。
 *
 * 出现时机：环境配置完成后、且用户没看过引导时自动出现一次（settings.onboardingSeen）。
 */
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Store,
  Users,
  LayoutDashboard,
  PackageCheck,
  Check,
  PartyPopper,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings';
import { useAgentsStore } from '@/stores/agents';
import { useTeamsStore } from '@/stores/teams';
import { useApprovalsStore } from '@/stores/approvals';
import {
  GUIDE_STEPS,
  countDoneGuideSteps,
  isGuideComplete,
  isGuideStepDone,
  type GuideSnapshot,
  type GuideStepId,
} from './guideProgress';

const STEP_ICONS: Record<GuideStepId, typeof Store> = {
  meetAgents: Store,
  buildTeam: Users,
  dispatchTask: LayoutDashboard,
  acceptDelivery: PackageCheck,
};

/** 全部完成后自动收起的延迟（ms），让用户看到全勾的完成态再关闭。 */
const AUTO_DISMISS_DELAY_MS = 1600;

/** 步骤文案的中文兜底（i18n 缺失时展示；正式文案在 src/i18n/locales 下 common.json 的 guide.steps）。 */
const STEP_TEXT_DEFAULTS: Record<GuideStepId, { title: string; desc: string; cta: string }> = {
  meetAgents: {
    title: '认识你的员工',
    desc: '去人才市场逛逛，挑一位 Agent 雇佣；雇好后他会出现在人力资产页。',
    cta: '去人才市场',
  },
  buildTeam: {
    title: '组建第一个团队',
    desc: '1 个 leader + 至少 1 名成员；leader 负责拆解任务、分派和验收。',
    cta: '去组建团队',
  },
  dispatchTask: {
    title: '派第一个团队任务',
    desc: '看板右上角「新建团队任务」，选团队、写需求，编排器自动跑完整条流水线。',
    cta: '去看板派任务',
  },
  acceptDelivery: {
    title: '验收第一份交付',
    desc: '团队任务完成后，在交付卡片里直接看内容，也可「打开交付目录」或「下载 ZIP」。',
    cta: '去验收交付',
  },
};

export function FirstRunGuide() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const tg = (key: string, defaultValue: string, options?: Record<string, unknown>) =>
    t(`common:guide.${key}`, { defaultValue, ...options });

  const setupComplete = useSettingsStore((s) => s.setupComplete);
  const onboardingSeen = useSettingsStore((s) => s.onboardingSeen);
  const guideOpen = useSettingsStore((s) => s.guideOpen);
  const markOnboardingSeen = useSettingsStore((s) => s.markOnboardingSeen);
  const closeGuide = useSettingsStore((s) => s.closeGuide);

  // 订阅业务状态：任一来源变化都会驱动步骤自动打勾
  const agentCount = useAgentsStore((s) => s.agents.length);
  const teamCount = useTeamsStore((s) => s.teams.length);
  const tasks = useApprovalsStore((s) => s.tasks);

  const snapshot = useMemo<GuideSnapshot>(
    () => ({ agentCount, teamCount, tasks }),
    [agentCount, teamCount, tasks],
  );
  const doneCount = countDoneGuideSteps(snapshot);
  const allDone = isGuideComplete(snapshot);

  const visible = setupComplete && (!onboardingSeen || guideOpen);

  /** 跳过/完成：写入持久完成态并关闭 */
  const dismiss = (): void => {
    markOnboardingSeen();
    closeGuide();
  };

  // 全部完成 → 短暂展示完成态后自动收起并记入完成态
  useEffect(() => {
    if (!visible || !allDone) return;
    const timer = window.setTimeout(dismiss, AUTO_DISMISS_DELAY_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, allDone]);

  // Esc 仅暂时关闭（不记完成态，未完成时下次启动仍会出现；与全局弹窗交互一致）
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeGuide();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  /** 去做：跳转对应页面并暂时收起引导（完成态由 store 自动判定，回来即见打勾） */
  const goTo = (route: string): void => {
    closeGuide();
    navigate(route);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-3xl border border-white/60 bg-white p-7 shadow-2xl dark:bg-[#1A1C1E]">
        <button
          type="button"
          onClick={closeGuide}
          aria-label={tg('close', '关闭引导')}
          className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-[#1A1C1E] dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-xl font-extrabold text-[#1A1C1E] dark:text-white">
          {tg('title', '四步上手 AgentCorp')}
        </h2>
        <p className="mt-1.5 text-[13px] text-gray-500">
          {tg('subtitle', '从雇人到交付验收，跟着清单做一遍就会了。')}
        </p>

        {/* 进度条 */}
        <div className="mt-5 flex items-center gap-2.5">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200 dark:bg-white/15">
            <div
              className="h-full rounded-full bg-[#FFD233] transition-all"
              style={{ width: `${(doneCount / GUIDE_STEPS.length) * 100}%` }}
            />
          </div>
          <span className="text-[11px] tabular-nums text-gray-400">
            {tg('progress', '已完成 {{done}}/{{total}}', { done: doneCount, total: GUIDE_STEPS.length })}
          </span>
        </div>

        {allDone ? (
          /* 完成态 */
          <div className="mt-6 flex min-h-[220px] flex-col items-center justify-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[#FFD233]/25">
              <PartyPopper className="h-6 w-6 text-[#1A1C1E] dark:text-[#FFD233]" />
            </div>
            <p className="mt-4 text-[15px] font-bold text-[#1A1C1E] dark:text-white">
              {tg('completeTitle', '全部完成，开张大吉')}
            </p>
            <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-gray-500">
              {tg('completeDesc', '你已经走完「雇人 → 组队 → 派活 → 验收」整条闭环，这个窗口稍后自动收起。')}
            </p>
            <Button className="mt-5" onClick={dismiss}>
              {tg('start', '开始使用')}
            </Button>
          </div>
        ) : (
          /* 步骤清单 */
          <ul className="mt-5 space-y-2.5">
            {GUIDE_STEPS.map((step, index) => {
              const done = isGuideStepDone(step.id, snapshot);
              const StepIcon = STEP_ICONS[step.id];
              return (
                <li
                  key={step.id}
                  aria-label={tg('stepLabel', '第 {{index}} 步：{{title}}', {
                    index: index + 1,
                    title: tg(`steps.${step.id}.title`, STEP_TEXT_DEFAULTS[step.id].title),
                  })}
                  className={`flex items-center gap-3.5 rounded-2xl border px-4 py-3 transition-colors ${
                    done
                      ? 'border-[#FFD233]/60 bg-[#FFD233]/10'
                      : 'border-gray-200 bg-white dark:border-white/10 dark:bg-white/[0.03]'
                  }`}
                >
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${
                      done
                        ? 'border-[#FFD233] bg-[#FFD233] text-[#1A1C1E]'
                        : 'border-gray-300 text-gray-400 dark:border-white/20'
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : index + 1}
                  </span>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-[#FFD233]/20">
                    <StepIcon className="h-5 w-5 text-[#1A1C1E] dark:text-[#FFD233]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-[13.5px] font-bold ${
                        done
                          ? 'text-gray-400 line-through dark:text-gray-500'
                          : 'text-[#1A1C1E] dark:text-white'
                      }`}
                    >
                      {tg(`steps.${step.id}.title`, STEP_TEXT_DEFAULTS[step.id].title)}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">
                      {tg(`steps.${step.id}.desc`, STEP_TEXT_DEFAULTS[step.id].desc)}
                    </p>
                  </div>
                  <Button
                    variant={done ? 'ghost' : 'default'}
                    onClick={() => goTo(step.route)}
                    className="shrink-0 text-[13px]"
                  >
                    {tg(`steps.${step.id}.cta`, STEP_TEXT_DEFAULTS[step.id].cta)} →
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {/* 操作区 */}
        {!allDone && (
          <div className="mt-4 flex items-center justify-end">
            <Button variant="ghost" onClick={dismiss} className="text-[13px] text-gray-400">
              {tg('skip', '跳过引导')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default FirstRunGuide;
