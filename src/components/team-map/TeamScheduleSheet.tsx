import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarClock, Plus, Trash2 } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useSchedulesStore } from '@/stores/schedules';
import { isValidCronExpression, parseCronExpression } from '../../../shared/schedule-cron';
import type { TeamSchedule } from '@/types/schedule';
import { cn } from '@/lib/utils';

/**
 * TeamScheduleSheet：团队「定时任务」管理面板。
 * 列表（指令摘要、cron 人类可读、上次触发、开关、删除）+ 新建表单
 * （标题、指令、cron 表达式带校验与示例）。触发由主进程 team-scheduler 执行。
 */

interface TeamScheduleSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string;
  teamName: string;
}

const CRON_EXAMPLES: Array<{ expr: string; label: string }> = [
  { expr: '0 9 * * *', label: '每天 9:00' },
  { expr: '*/30 * * * *', label: '每 30 分钟' },
  { expr: '0 9 * * 1', label: '每周一 9:00' },
  { expr: '0 9 1 * *', label: '每月 1 日 9:00' },
];

/** cron 人类可读描述：常见模式直译，其余回退到原表达式。 */
export function describeCron(cron: string): string {
  const parsed = parseCronExpression(cron);
  if (!parsed) return cron;
  const [minuteExpr, hourExpr, domExpr, , dowExpr] = cron.trim().split(/\s+/);

  const pad = (value: string) => value.padStart(2, '0');
  const timeText = !parsed.minute.any && !parsed.hour.any && parsed.minute.values.size === 1 && parsed.hour.values.size === 1
    ? `${pad(String([...parsed.hour.values][0]))}:${pad(String([...parsed.minute.values][0]))}`
    : null;

  if (parsed.dayOfMonth.any && parsed.dayOfWeek.any && timeText) {
    return `每天 ${timeText}`;
  }
  if (parsed.dayOfMonth.any && !parsed.dayOfWeek.any && timeText && parsed.dayOfWeek.values.size === 1) {
    return `每周${['日', '一', '二', '三', '四', '五', '六'][[...parsed.dayOfWeek.values][0]]} ${timeText}`;
  }
  if (!parsed.dayOfMonth.any && parsed.dayOfWeek.any && timeText && parsed.dayOfMonth.values.size === 1) {
    return `每月 ${[...parsed.dayOfMonth.values][0]} 日 ${timeText}`;
  }
  if (/^\*\/\d+$/.test(minuteExpr) && hourExpr === '*' && domExpr === '*' && dowExpr === '*') {
    return `每 ${minuteExpr.slice(2)} 分钟`;
  }
  return cron;
}

function formatLastFired(lastFiredAt: string | undefined): string {
  if (!lastFiredAt) return '从未触发';
  const date = new Date(lastFiredAt);
  if (Number.isNaN(date.getTime())) return '从未触发';
  return date.toLocaleString();
}

function ScheduleRow({
  schedule,
  onToggle,
  onDelete,
}: {
  schedule: TeamSchedule;
  onToggle: (schedule: TeamSchedule, enabled: boolean) => void;
  onDelete: (schedule: TeamSchedule) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{schedule.title}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{schedule.instruction}</p>
        </div>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={(checked) => onToggle(schedule, checked)}
          aria-label="启用开关"
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
            {describeCron(schedule.cron)}
          </span>
          <span className="truncate">上次触发：{formatLastFired(schedule.lastFiredAt)}</span>
        </div>
        <button
          type="button"
          onClick={() => onDelete(schedule)}
          className="shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500"
          aria-label="删除定时任务"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function CreateScheduleForm({
  teamId,
  onCreated,
}: {
  teamId: string;
  onCreated: () => void;
}) {
  const createSchedule = useSchedulesStore((state) => state.createSchedule);
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [cron, setCron] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const cronTouched = cron.trim().length > 0;
  const cronValid = !cronTouched || isValidCronExpression(cron);
  const canSubmit = title.trim().length > 0 && instruction.trim().length > 0 && cronTouched && cronValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await createSchedule({
        teamId,
        title: title.trim(),
        instruction: instruction.trim(),
        cron: cron.trim(),
        enabled: true,
      });
      toast.success(`已创建定时任务「${title.trim()}」`);
      setTitle('');
      setInstruction('');
      setCron('');
      onCreated();
    } catch (error) {
      toast.error(`创建定时任务失败: ${String(error)}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <div className="space-y-2">
        <Label htmlFor="schedule-title">标题</Label>
        <Input
          id="schedule-title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="例如：每日晨报"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="schedule-instruction">指令</Label>
        <Textarea
          id="schedule-instruction"
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="到点自动创建团队任务，指令会作为任务描述交给团队执行..."
          rows={4}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="schedule-cron">调度规则（cron 表达式：分 时 日 月 周）</Label>
        <Input
          id="schedule-cron"
          value={cron}
          onChange={(event) => setCron(event.target.value)}
          placeholder="0 9 * * *"
          className={cn(!cronValid && 'border-red-300 focus-visible:ring-red-200')}
        />
        {!cronValid ? (
          <p className="text-xs text-red-500">
            cron 表达式不合法：支持 *、*/n、数字和逗号列表，例如 0 9 * * * = 每天 9 点
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {CRON_EXAMPLES.map((example) => (
              <button
                key={example.expr}
                type="button"
                onClick={() => setCron(example.expr)}
                className="rounded-full bg-white px-2.5 py-1 text-[11px] font-medium text-slate-500 ring-1 ring-slate-200 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                {example.expr} · {example.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <Button type="button" onClick={handleSubmit} disabled={!canSubmit} className="w-full">
        <Plus className="h-4 w-4" />
        {submitting ? '创建中...' : '创建定时任务'}
      </Button>
    </div>
  );
}

export function TeamScheduleSheet({ open, onOpenChange, teamId, teamName }: TeamScheduleSheetProps) {
  const { t } = useTranslation('common');
  const { schedules, loading, fetchSchedules, updateSchedule, deleteSchedule } = useSchedulesStore();
  const [confirmDelete, setConfirmDelete] = useState<TeamSchedule | null>(null);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (open) {
      void fetchSchedules();
    }
  }, [open, fetchSchedules]);

  const teamSchedules = schedules.filter((schedule) => schedule.teamId === teamId);

  const handleToggle = async (schedule: TeamSchedule, enabled: boolean) => {
    try {
      await updateSchedule(schedule.id, { enabled });
    } catch (error) {
      toast.error(`更新定时任务失败: ${String(error)}`);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deleteSchedule(confirmDelete.id);
      toast.success(`已删除定时任务「${confirmDelete.title}」`);
    } catch (error) {
      toast.error(`删除定时任务失败: ${String(error)}`);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col sm:max-w-[520px]">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              定时任务
            </SheetTitle>
            <SheetDescription>
              {t('teamMap.schedules.description', {
                defaultValue: `为「${teamName}」配置周期任务，到点自动创建团队任务并执行`,
              })}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 min-h-0 flex-1 space-y-3 overflow-y-auto">
            {loading && teamSchedules.length === 0 ? (
              <p className="py-8 text-center text-sm text-slate-400">{t('status.loading')}</p>
            ) : teamSchedules.length === 0 && !showForm ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-6 py-8 text-center">
                <CalendarClock className="mx-auto h-8 w-8 text-slate-300" />
                <p className="mt-3 text-sm font-medium text-slate-500">暂无定时任务</p>
                <p className="mt-1 text-xs text-slate-400">创建后将按调度规则自动派发任务给团队</p>
              </div>
            ) : (
              teamSchedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  schedule={schedule}
                  onToggle={(target, enabled) => void handleToggle(target, enabled)}
                  onDelete={setConfirmDelete}
                />
              ))
            )}

            {showForm ? (
              <CreateScheduleForm teamId={teamId} onCreated={() => setShowForm(false)} />
            ) : (
              <Button type="button" variant="outline" onClick={() => setShowForm(true)} className="w-full">
                <Plus className="h-4 w-4" />
                新建定时任务
              </Button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="删除定时任务"
        message={confirmDelete ? `确定删除「${confirmDelete.title}」？删除后不再自动创建任务。` : ''}
        confirmLabel="删除"
        cancelLabel="取消"
        variant="destructive"
        onConfirm={() => void handleDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </>
  );
}
