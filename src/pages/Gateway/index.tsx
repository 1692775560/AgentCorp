/**
 * Ecosystem Gateway Page
 * 生态网关 — Agent 执行网关状态总览。
 *
 * NOTE: IM 渠道集成（钉钉 / 企业微信 / QQ 机器人 / 飞书 / 微信）已在 AgentCorp
 * 本页仅保留网关状态总览，不承载渠道管理 UI。
 */
import { Network, Sparkles } from 'lucide-react';

export default function Gateway() {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-[#fcfcfe] custom-scrollbar">
      <div className="px-8 pt-7 pb-5">
        <div className="rounded-[28px] border border-black/[0.06] bg-[radial-gradient(90%_120%_at_0%_0%,rgba(253,230,138,0.45),rgba(255,255,255,0.95))] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-900 text-white shadow-sm">
                <Network className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-[24px] font-bold tracking-tight text-slate-900">生态网关</h1>
                <p className="mt-1 text-[13px] text-slate-500">Agent 执行网关状态总览</p>
              </div>
            </div>
            <div className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] font-semibold text-amber-700">
              <Sparkles size={13} />
              ClawFirm Style
            </div>
          </div>
        </div>
      </div>

      <div className="px-8 pb-8">
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-9 text-center">
          <p className="text-[14px] font-semibold text-slate-500">渠道集成已移除</p>
          <p className="mt-1 text-[12px] text-slate-400">
            AgentCorp 已移除 IM 渠道（钉钉 / 企业微信 / QQ 机器人 / 飞书 / 微信）集成，仅保留 Agent 执行与评估能力。
          </p>
        </div>
      </div>
    </div>
  );
}
