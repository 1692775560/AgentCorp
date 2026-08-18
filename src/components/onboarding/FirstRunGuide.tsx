/**
 * src/components/onboarding/FirstRunGuide.tsx
 * 新手引导：分页向导，把完整业务闭环一次讲清。
 *
 * 与 pages/Setup 的分工：Setup 解决「环境能不能跑」（runtime / provider），
 * 本组件解决「进来该干什么」—— 雇人 → 面试 → 组队 → 派团队任务 → 验收交付。
 *
 * 出现时机：环境配置完成后、且用户没看过引导时自动出现一次（settings.onboardingSeen）；
 * 之后可从侧边栏「新手引导」随时重看（settings.guideOpen，不持久化）。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Store,
  MessagesSquare,
  Users,
  LayoutDashboard,
  PackageCheck,
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings';

interface GuideStep {
  icon: typeof Store;
  title: string;
  desc: string;
  points: string[];
  route: string;
  cta: string;
}

const STEPS: GuideStep[] = [
  {
    icon: Store,
    title: '人才市场 · 雇一位 Agent 员工',
    desc: '从市场挑人，或把自己上传成 Agent。',
    points: [
      '浏览/搜索开源 Agent，点进详情看能力画像',
      '点「雇佣」后，他就进了你的员工列表（人力资产页）',
      '一个人只能单打独斗，团队任务需要先组队（第 3 步）',
    ],
    route: '/marketplace',
    cta: '去人才市场',
  },
  {
    icon: MessagesSquare,
    title: 'HR 面试 · 让大模型考他',
    desc: '同题同评分标准，逐条给出命中与原文引用，不看仓库 star 数，个人 Agent 也能被公平评估。',
    points: [
      '选好候选人点「开始面试」，题序按岗位画像自动生成',
      '点「让候选作答」真实调度大模型回答，你逐维打分',
      '面试报告会回写评估中心，两张榜（客观分 / 你的偏好）可对照',
    ],
    route: '/interview',
    cta: '去面试',
  },
  {
    icon: Users,
    title: '组建团队 · 1 个 leader + 至少 1 名成员',
    desc: '团队是多 agent 协同的前提。',
    points: [
      '在「组建团队」页挑一个 leader 和若干成员',
      'leader 负责拆解任务、分派和验收；成员并行执行',
      '团队建好后会出现在人力资产页和看板的派单列表里',
    ],
    route: '/team-builder',
    cta: '去组建团队',
  },
  {
    icon: LayoutDashboard,
    title: '任务看板 · 下发团队任务',
    desc: '说一句需求，编排器自动跑完整条流水线。',
    points: [
      '看板右上角「新建团队任务」，选团队、写标题和描述',
      '编排器自动拆解子任务 → 指派成员并行 → 互相审阅返工 → 汇总',
      '点任务卡片可看每一步的执行时间线；失败了可「点我重试」',
    ],
    route: '/office',
    cta: '去看板派任务',
  },
  {
    icon: PackageCheck,
    title: '验收交付 · 文件落盘，随取随用',
    desc: '交付物不只是聊天记录，是真实文件。',
    points: [
      '任务完成后，交付卡片里直接渲染交付内容（Markdown 排版）',
      '「打开交付目录」查看落盘的真实文件（代码、报告、网页…）',
      '「下载 ZIP」一键打包，代码类交付可直接运行',
    ],
    route: '/office',
    cta: '去验收交付',
  },
];

export function FirstRunGuide() {
  const navigate = useNavigate();
  const setupComplete = useSettingsStore((s) => s.setupComplete);
  const onboardingSeen = useSettingsStore((s) => s.onboardingSeen);
  const guideOpen = useSettingsStore((s) => s.guideOpen);
  const markOnboardingSeen = useSettingsStore((s) => s.markOnboardingSeen);
  const closeGuide = useSettingsStore((s) => s.closeGuide);

  const visible = setupComplete && (!onboardingSeen || guideOpen);
  const [stepIndex, setStepIndex] = useState(0);

  const dismiss = (): void => {
    markOnboardingSeen();
    closeGuide();
  };

  // Esc 关闭（与全局弹窗交互一致）
  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (!visible) return null;

  const step = STEPS[stepIndex];
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  const goTo = (route: string): void => {
    dismiss();
    navigate(route);
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-3xl border border-white/60 bg-white p-7 shadow-2xl dark:bg-[#1A1C1E]">
        <button
          type="button"
          onClick={dismiss}
          aria-label="关闭引导"
          className="absolute right-4 top-4 text-gray-400 transition-colors hover:text-[#1A1C1E] dark:hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-xl font-extrabold text-[#1A1C1E] dark:text-white">
          五步上手 AgentCorp
        </h2>
        <p className="mt-1.5 text-[13px] text-gray-500">
          从雇人到交付验收，一条主线走完整个闭环。
        </p>

        {/* 进度点 */}
        <div className="mt-5 flex items-center gap-1.5">
          {STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              aria-label={`第 ${i + 1} 步：${s.title}`}
              onClick={() => setStepIndex(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === stepIndex ? 'w-6 bg-[#FFD233]' : 'w-1.5 bg-gray-200 hover:bg-gray-300 dark:bg-white/15'
              }`}
            />
          ))}
          <span className="ml-auto text-[11px] tabular-nums text-gray-400">
            {stepIndex + 1} / {STEPS.length}
          </span>
        </div>

        {/* 当前步骤 */}
        <div className="mt-5 min-h-[220px]">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#FFD233]/20">
              <step.icon className="h-5 w-5 text-[#1A1C1E] dark:text-[#FFD233]" />
            </div>
            <div className="min-w-0">
              <p className="text-[14px] font-bold text-[#1A1C1E] dark:text-white">
                {stepIndex + 1}. {step.title}
              </p>
              <p className="mt-0.5 text-[12px] text-gray-500">{step.desc}</p>
            </div>
          </div>
          <ul className="mt-4 space-y-2.5">
            {step.points.map((point) => (
              <li key={point} className="flex gap-2 text-[12.5px] leading-relaxed text-gray-600 dark:text-gray-300">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-[#FFD233]" />
                {point}
              </li>
            ))}
          </ul>
        </div>

        {/* 操作区 */}
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="ghost"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={isFirst}
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" />
            上一步
          </Button>
          <Button variant="ghost" onClick={() => goTo(step.route)} className="text-[13px]">
            {step.cta} →
          </Button>
          <div className="flex-1" />
          {isLast ? (
            <Button onClick={dismiss}>开始使用</Button>
          ) : (
            <Button onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}>
              下一步
              <ChevronRight className="ml-1 h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export default FirstRunGuide;
