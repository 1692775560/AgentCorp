/**
 * src/components/onboarding/FirstRunGuide.tsx
 * 首次启动的业务动线引导。
 *
 * 与 pages/Setup 的分工：Setup 解决「环境能不能跑」（runtime / provider），
 * 本组件解决「进来该干什么」—— 把 S1 人才市场 → S2 HR 面试 → S3 评估中心
 * 这条主线一次讲清，并把用户直接送到第一步。
 *
 * 只在环境配置完成后、且用户没看过引导时出现一次（settings.onboardingSeen）。
 */
import { useNavigate } from 'react-router-dom';
import { Store, MessagesSquare, BarChart3, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useSettingsStore } from '@/stores/settings';

const STEPS = [
  {
    icon: Store,
    title: '人才市场 · 雇一位员工',
    desc: '导入 GitHub 上的开源 Agent，或把自己上传成 Agent。雇佣后他就进了你的员工列表。',
  },
  {
    icon: MessagesSquare,
    title: 'HR 面试 · 让大模型考他',
    desc: '同题同评分标准，逐条给出命中与原文引用，不看仓库 star 数，个人 Agent 也能公平参赛。',
  },
  {
    icon: BarChart3,
    title: '评估中心 · 看谁更合适',
    desc: '客观指标一张榜，你自己的审美偏好另一张榜，两张榜可以不一致。',
  },
] as const;

export function FirstRunGuide() {
  const navigate = useNavigate();
  const setupComplete = useSettingsStore((s) => s.setupComplete);
  const onboardingSeen = useSettingsStore((s) => s.onboardingSeen);
  const markOnboardingSeen = useSettingsStore((s) => s.markOnboardingSeen);

  if (!setupComplete || onboardingSeen) return null;

  const dismiss = (): void => {
    markOnboardingSeen();
  };

  const start = (): void => {
    markOnboardingSeen();
    navigate('/marketplace');
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
          三步找到合适的 Agent 员工
        </h2>
        <p className="mt-1.5 text-[13px] text-gray-500">
          AgentCorp 只有一条主线，按顺序走就行。
        </p>

        <ol className="mt-6 space-y-4">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3.5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-[#FFD233]/20">
                <step.icon className="h-4.5 w-4.5 text-[#1A1C1E] dark:text-[#FFD233]" />
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-bold text-[#1A1C1E] dark:text-white">
                  {i + 1}. {step.title}
                </p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-gray-500">{step.desc}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-7 flex items-center gap-2">
          <Button onClick={start} className="flex-1">
            去人才市场雇第一位员工
          </Button>
          <Button variant="ghost" onClick={dismiss}>
            我自己逛逛
          </Button>
        </div>
      </div>
    </div>
  );
}

export default FirstRunGuide;
