/**
 * src/engine/evaluationAdapter.ts
 * 适配层（评估 / playbook §2.6）：把 EvaluationEvent 流（Mock 或未来真实 SSE）
 * 增量转换为内部状态（RadarScore 逐维点亮 / KpiRecord / RoiSnapshot / LifecycleState），
 * 供看板组件消费。
 *
 * 关键约束：
 * - 真实分支接口已预留，但阶段 A 仅接 Mock 分支；真实 SSE 接入点以 TODO 标注，
 *   后续接朋友模型层时零改动（只需在 useEvaluation 中把事件喂给 consume）。
 * - 客观 KPI/ROI 由 metricsEngine / roiEngine 聚合后通过 ingestKpi / ingestRoi 灌入，
 *   narration/audio 事件走语音通道（返回 noop，由 useSpeech 处理）。
 */
import {
  EvaluationEvent,
  RadarScore,
  RadarDim,
  KpiRecord,
  RoiSnapshot,
  LifecycleState,
  Verdict,
} from "../types/evaluation";

/** 消费单个事件后需要 UI 刷新的切片 */
export type AdapterDelta =
  | { kind: "radar"; dim: RadarDim; score: number }
  | { kind: "verdict"; verdict: Verdict; fit: number }
  | { kind: "done" }
  | { kind: "noop" };

/** 内部快照（组件消费的聚合态） */
export interface AdapterSnapshot {
  radar: Partial<RadarScore>;
  kpi?: KpiRecord;
  roi?: RoiSnapshot;
  state: LifecycleState;
}

export class EvaluationAdapter {
  private radar: Partial<RadarScore> = {};
  private kpi?: KpiRecord;
  private roi?: RoiSnapshot;
  private state: LifecycleState = "ONBOARDING";

  /**
   * 消费一个评估事件，返回需要 UI 刷新的切片。
   * narration / audio 事件不在此处理（返回 noop，交由 useSpeech 播放）。
   */
  consume(ev: EvaluationEvent): AdapterDelta {
    switch (ev.type) {
      case "radar_update":
        // 逐维点亮
        this.radar[ev.dim] = ev.score;
        return { kind: "radar", dim: ev.dim, score: ev.score };
      case "verdict":
        // 入职评估：MVP / OBSERVE 通过入职，FIRED 淘汰
        this.state = this.applyVerdict(ev.verdict);
        return { kind: "verdict", verdict: ev.verdict, fit: ev.user_fit };
      case "done":
        return { kind: "done" };
      default:
        // narration / audio 走语音通道
        return { kind: "noop" };
    }
  }

  /** 入职评估 → 生命周期初态（主观宣判映射） */
  private applyVerdict(verdict: Verdict): LifecycleState {
    return verdict === "FIRED" ? "RETIRED" : "ACTIVE";
  }

  /** 阶段 C 用：把聚合后的 KPI 灌入 */
  ingestKpi(kpi: KpiRecord): void {
    this.kpi = kpi;
  }

  /** 阶段 C 用：把聚合后的 ROI 灌入 */
  ingestRoi(roi: RoiSnapshot): void {
    this.roi = roi;
  }

  /** 显式设置生命周期初态（如入职已通过，直接置 ACTIVE） */
  setState(state: LifecycleState): void {
    this.state = state;
  }

  /** 导出当前内部状态快照 */
  snapshot(): AdapterSnapshot {
    return {
      radar: { ...this.radar },
      kpi: this.kpi,
      roi: this.roi,
      state: this.state,
    };
  }
}

/**
 * TODO（阶段 B）：接朋友真实 SSE 分支。
 * 真实模式下，useEvaluation 应把从 /api/evaluate 解析出的 EvaluationEvent 直接
 * 传给 `adapter.consume(ev)`（与 Mock 共用同一条路径），无需改动本适配层。
 * 真实 KPI/ROI 由 telemetryAdapter（阶段 C）回传后调用 ingestKpi/ingestRoi。
 */
