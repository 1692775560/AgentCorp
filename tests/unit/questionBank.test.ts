/**
 * tests/unit/questionBank.test.ts
 *
 * 面试题库与选题引擎单测（模块 B · 设计 §5.3 / §7 通道①）：
 *  - questionsOf         —— 按阶段 + 工种筛选题池（'any' 题恒可用）
 *  - selectQuestions     —— P1/P2/P3 三阶段递进题序 + 通道① dimBoost 影响
 *  - boostedDims / questionBoostWeight —— 强调维抽取与选题权重
 *  - nextQuestion / renderPrompt / planTargetDims / makeFollowupQuestion
 *
 * 测试重点：code/text/image 三工种各能选出非空三阶段题目，且 targetDims 与工种匹配。
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/questionBank.test.ts
 */
import { describe, it, expect } from 'vitest';
import type { JobType } from '@/types/evaluation';
import type { InterviewPhase } from '@/types/interview';
import {
  DEFAULT_PER_PHASE,
  PHASE_LABELS,
  PHASE_ORDER,
  QUESTION_BANK,
  TASK_PLACEHOLDER,
  boostedDims,
  makeFollowupQuestion,
  mergeDims,
  nextQuestion,
  planTargetDims,
  questionBoostWeight,
  questionsOf,
  renderPrompt,
  selectQuestions,
} from '@/engine/interview/questionBank';

/** 工种 → craft 维前缀（targetDims 与工种匹配性校验用） */
const CRAFT_PREFIX: Record<JobType, string> = {
  image: 'img_',
  text: 'txt_',
  code: 'code_',
};

const ALL_JOB_TYPES: JobType[] = ['image', 'text', 'code'];

describe('questionBank · 题库自洽性', () => {
  it('三阶段顺序固定为 P1 → P2 → P3', () => {
    expect(PHASE_ORDER).toEqual(['P1_understanding', 'P2_craft_probe', 'P3_pressure']);
  });

  it('qId 全局唯一', () => {
    const ids = QUESTION_BANK.map((q) => q.qId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每道题都有非空题干与至少一个考查维度', () => {
    for (const q of QUESTION_BANK) {
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(q.targetDims.length).toBeGreaterThan(0);
      expect(PHASE_ORDER).toContain(q.phase);
    }
  });

  it('每个阶段都有中文标签', () => {
    for (const phase of PHASE_ORDER) {
      expect(PHASE_LABELS[phase].length).toBeGreaterThan(0);
    }
  });
});

describe('questionBank · questionsOf（题池筛选）', () => {
  it('★ 三工种在三个阶段均能取到非空题池', () => {
    for (const jobType of ALL_JOB_TYPES) {
      for (const phase of PHASE_ORDER) {
        expect(questionsOf(phase, jobType).length).toBeGreaterThan(0);
      }
    }
  });

  it('题池内的题目阶段与工种均匹配（any 题恒可用）', () => {
    for (const jobType of ALL_JOB_TYPES) {
      for (const phase of PHASE_ORDER) {
        for (const q of questionsOf(phase, jobType)) {
          expect(q.phase).toBe(phase);
          expect(['any', jobType]).toContain(q.jobType);
        }
      }
    }
  });

  it('★ P2 手艺探针按工种隔离：不会串到其他工种的 craft 题', () => {
    for (const jobType of ALL_JOB_TYPES) {
      const pool = questionsOf('P2_craft_probe', jobType);
      expect(pool.length).toBeGreaterThan(0);
      for (const q of pool) {
        expect(['any', jobType]).toContain(q.jobType);
      }
    }
  });

  it('★ P2 题的 targetDims 含本工种 craft 维（前缀匹配）', () => {
    for (const jobType of ALL_JOB_TYPES) {
      const prefix = CRAFT_PREFIX[jobType];
      for (const q of questionsOf('P2_craft_probe', jobType)) {
        if (q.jobType === 'any') continue; // 通用决胜题（p2_decisive_task）不要求 craft 维
        const craftDims = q.targetDims.filter((d) => String(d).includes('_'));
        expect(craftDims.length).toBeGreaterThan(0);
        for (const dim of craftDims) {
          expect(String(dim).startsWith(prefix)).toBe(true);
        }
      }
    }
  });

  it('P1 / P3 为三工种通用题（jobType = any）', () => {
    for (const phase of ['P1_understanding', 'P3_pressure'] as InterviewPhase[]) {
      for (const q of questionsOf(phase, 'code')) {
        expect(q.jobType).toBe('any');
      }
    }
  });

  it("工种为 null → 退化为 'code' 探针（仍能出题）", () => {
    const pool = questionsOf('P2_craft_probe', null);
    expect(pool.length).toBeGreaterThan(0);
    expect(pool).toEqual(questionsOf('P2_craft_probe', 'code'));
  });
});

describe('questionBank · boostedDims / questionBoostWeight', () => {
  it('抽取 >= 阈值的强调维并按系数降序', () => {
    expect(boostedDims({ creativity: 1.4, quality: 1.2 })).toEqual(['creativity', 'quality']);
    expect(boostedDims({ cost: 1.5, reliability: 1.5 })).toHaveLength(2);
  });

  it('低于阈值（1.05）的维度不算强调', () => {
    expect(boostedDims({ quality: 1.0 })).toEqual([]);
    expect(boostedDims({ quality: 1.02 })).toEqual([]);
    expect(boostedDims({ quality: 1.05 })).toEqual(['quality']);
  });

  it('边界：无 dimBoost / 空对象 → 空数组', () => {
    expect(boostedDims(undefined)).toEqual([]);
    expect(boostedDims({})).toEqual([]);
  });

  it('questionBoostWeight：累加交集维的超出量（boost-1）', () => {
    const q = QUESTION_BANK.find((item) => item.qId === 'p3_deadline')!;
    // targetDims = reliability / task / cost
    expect(questionBoostWeight(q, { cost: 1.5 })).toBeCloseTo(0.5, 10);
    expect(questionBoostWeight(q, { cost: 1.5, reliability: 1.5 })).toBeCloseTo(1.0, 10);
    expect(questionBoostWeight(q, { creativity: 1.4 })).toBe(0);
    expect(questionBoostWeight(q, undefined)).toBe(0);
  });
});

describe('questionBank · selectQuestions（★ 三阶段递进题序）', () => {
  it('★ code/text/image 三工种均能选出非空的三阶段题目', () => {
    for (const jobType of ALL_JOB_TYPES) {
      const plan = selectQuestions({ jobType });
      for (const phase of PHASE_ORDER) {
        const inPhase = plan.filter((q) => q.phase === phase);
        expect(inPhase.length).toBeGreaterThan(0);
      }
    }
  });

  it('默认取题数 = DEFAULT_PER_PHASE（2 + 4 + 4 = 10）', () => {
    const total = Object.values(DEFAULT_PER_PHASE).reduce((a, b) => a + b, 0);
    for (const jobType of ALL_JOB_TYPES) {
      const plan = selectQuestions({ jobType });
      expect(plan).toHaveLength(total);
      expect(plan.filter((q) => q.phase === 'P1_understanding')).toHaveLength(
        DEFAULT_PER_PHASE.P1_understanding,
      );
      expect(plan.filter((q) => q.phase === 'P2_craft_probe')).toHaveLength(
        DEFAULT_PER_PHASE.P2_craft_probe,
      );
      expect(plan.filter((q) => q.phase === 'P3_pressure')).toHaveLength(
        DEFAULT_PER_PHASE.P3_pressure,
      );
    }
  });

  it('★ 题序严格按 P1 → P2 → P3 排列（阶段不交错）', () => {
    const plan = selectQuestions({ jobType: 'code' });
    const order = plan.map((q) => PHASE_ORDER.indexOf(q.phase));
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
    }
  });

  it('★ 选出的 P2 题 targetDims 与工种匹配', () => {
    for (const jobType of ALL_JOB_TYPES) {
      const plan = selectQuestions({ jobType });
      const prefix = CRAFT_PREFIX[jobType];
      const p2 = plan.filter((q) => q.phase === 'P2_craft_probe');
      for (const q of p2) {
        expect(q.jobType).toBe(jobType);
        const craftDims = q.targetDims.filter((d) => String(d).includes('_'));
        for (const dim of craftDims) {
          expect(String(dim).startsWith(prefix)).toBe(true);
        }
      }
    }
  });

  it('题序内无重复题目', () => {
    const plan = selectQuestions({ jobType: 'image' });
    const ids = plan.map((q) => q.qId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('perPhase 可覆盖每阶段取题数；设为 0 则跳过该阶段', () => {
    const plan = selectQuestions({
      jobType: 'code',
      perPhase: { P1_understanding: 1, P2_craft_probe: 5, P3_pressure: 0 },
    });
    expect(plan.filter((q) => q.phase === 'P1_understanding')).toHaveLength(1);
    expect(plan.filter((q) => q.phase === 'P2_craft_probe')).toHaveLength(5);
    expect(plan.filter((q) => q.phase === 'P3_pressure')).toHaveLength(0);
  });

  it('取题数超过题池容量时按题池上限返回（不报错、不补空）', () => {
    const plan = selectQuestions({
      jobType: 'code',
      perPhase: { P1_understanding: 99, P2_craft_probe: 0, P3_pressure: 0 },
    });
    expect(plan.length).toBe(questionsOf('P1_understanding', 'code').length);
  });

  it('★ 通道①：dimBoost 改变 P3 选题（cost 被强调 → 成本题入选）', () => {
    const base = selectQuestions({ jobType: 'code' })
      .filter((q) => q.phase === 'P3_pressure')
      .map((q) => q.qId);
    const boosted = selectQuestions({ jobType: 'code', dimBoost: { cost: 1.5 } })
      .filter((q) => q.phase === 'P3_pressure')
      .map((q) => q.qId);

    expect(base).not.toContain('p3_cost');
    expect(boosted).toContain('p3_cost');
  });

  it('★ 通道①：P1 题的 targetDims 追加强调维（保证首轮即被观测）', () => {
    const plan = selectQuestions({ jobType: 'code', dimBoost: { cost: 1.5 } });
    const p1 = plan.filter((q) => q.phase === 'P1_understanding');
    for (const q of p1) {
      expect(q.targetDims).toContain('cost');
    }
  });

  it('通道①：无 dimBoost 时 P1 targetDims 保持题库原值（不注入）', () => {
    const plan = selectQuestions({ jobType: 'code' });
    const first = plan.find((q) => q.qId === 'p1_restate')!;
    expect(first.targetDims).toEqual(['task', 'comm']);
  });

  it('追加强调维时去重，且不污染原题库对象（纯函数）', () => {
    const before = JSON.parse(JSON.stringify(QUESTION_BANK));
    const plan = selectQuestions({ jobType: 'code', dimBoost: { task: 1.5, comm: 1.5 } });
    const first = plan.find((q) => q.qId === 'p1_restate')!;
    expect(first.targetDims).toEqual(['task', 'comm']);
    expect(new Set(first.targetDims).size).toBe(first.targetDims.length);
    expect(QUESTION_BANK).toEqual(before);
  });

  it('确定性：同参数两次调用结果深度相等', () => {
    const opts = { jobType: 'text' as JobType, dimBoost: { quality: 1.4 } };
    expect(selectQuestions(opts)).toEqual(selectQuestions(opts));
  });

  it("工种为 null → 退化为 'code' 题序，仍覆盖三阶段", () => {
    const plan = selectQuestions({ jobType: null });
    const total = Object.values(DEFAULT_PER_PHASE).reduce((a, b) => a + b, 0);
    expect(plan).toHaveLength(total);
    expect(plan).toEqual(selectQuestions({ jobType: 'code' }));
  });
});

describe('questionBank · 题序辅助函数', () => {
  it('nextQuestion：返回首个未问的题；全部问完 → null', () => {
    const plan = selectQuestions({ jobType: 'code' });
    expect(nextQuestion(plan, [])?.qId).toBe(plan[0].qId);
    expect(nextQuestion(plan, [plan[0].qId])?.qId).toBe(plan[1].qId);
    expect(nextQuestion(plan, plan.map((q) => q.qId))).toBeNull();
  });

  it('nextQuestion：空题序 → null', () => {
    expect(nextQuestion([], [])).toBeNull();
  });

  it('renderPrompt：替换占位符为需求文本', () => {
    const rendered = renderPrompt(`请复述：${TASK_PLACEHOLDER}。`, { taskText: '做一个登录接口' });
    expect(rendered).toBe('请复述：做一个登录接口。');
    expect(rendered).not.toContain(TASK_PLACEHOLDER);
  });

  it('renderPrompt：无需求文本时回退到标签拼接，再退化为「本次任务」', () => {
    expect(renderPrompt(TASK_PLACEHOLDER, { tags: ['代码', '稳定'] })).toBe('代码、稳定');
    expect(renderPrompt(TASK_PLACEHOLDER, {})).toBe('本次任务');
    expect(renderPrompt(TASK_PLACEHOLDER, { taskText: '   ' })).toBe('本次任务');
  });

  it('renderPrompt：替换全部出现位置；无占位符时原样返回', () => {
    expect(renderPrompt(`${TASK_PLACEHOLDER}-${TASK_PLACEHOLDER}`, { taskText: 'X' })).toBe('X-X');
    expect(renderPrompt('没有占位符', { taskText: 'X' })).toBe('没有占位符');
  });

  it('★ 题序渲染后不残留占位符（面试页直接可用）', () => {
    for (const jobType of ALL_JOB_TYPES) {
      for (const q of selectQuestions({ jobType })) {
        expect(renderPrompt(q.prompt, { taskText: '做一个登录接口' })).not.toContain(
          TASK_PLACEHOLDER,
        );
      }
    }
  });

  it('planTargetDims：汇总去重全部考查维度', () => {
    const plan = selectQuestions({ jobType: 'code' });
    const dims = planTargetDims(plan);
    expect(dims.length).toBeGreaterThan(0);
    expect(new Set(dims).size).toBe(dims.length);
    for (const q of plan) {
      for (const dim of q.targetDims) expect(dims).toContain(dim);
    }
  });

  it('planTargetDims：空题序 → 空数组', () => {
    expect(planTargetDims([])).toEqual([]);
  });

  it('mergeDims：合并去重并保持先后顺序', () => {
    expect(mergeDims(['task', 'comm'], ['comm', 'cost'])).toEqual(['task', 'comm', 'cost']);
    expect(mergeDims([], ['task'])).toEqual(['task']);
    expect(mergeDims(['task'], [])).toEqual(['task']);
  });

  it('makeFollowupQuestion：qId 追加 :fu 后缀并继承阶段与考查维', () => {
    const base = QUESTION_BANK[0];
    const followup = makeFollowupQuestion(base, '请再具体一点。', 2);
    expect(followup.qId).toBe(`${base.qId}:fu2`);
    expect(followup.qId).toContain(':fu');
    expect(followup.phase).toBe(base.phase);
    expect(followup.jobType).toBe(base.jobType);
    expect(followup.prompt).toBe('请再具体一点。');
    expect(followup.targetDims).toEqual(base.targetDims);
  });

  it('makeFollowupQuestion：默认序号为 1，且不改动原题（拷贝 targetDims）', () => {
    const base = QUESTION_BANK[0];
    const followup = makeFollowupQuestion(base, '追问');
    expect(followup.qId).toBe(`${base.qId}:fu1`);
    expect(followup.targetDims).not.toBe(base.targetDims);
  });
});

describe('questionBank · 区分性题（#132）', () => {
  it('题库包含区分性题（决胜任务 + 4 类压力题）', () => {
    const ids = QUESTION_BANK.map((q) => q.qId);
    for (const id of [
      'p2_decisive_task',
      'p3_incomplete',
      'p3_conflict',
      'p3_overreach',
      'p3_cost_bound',
    ]) {
      expect(ids, `题库应含 ${id}`).toContain(id);
    }
  });

  it('P3 默认取题露出全部 4 道区分性题（信息残缺/冲突/越权/成本）', () => {
    const plan = selectQuestions({ jobType: 'code' });
    const p3 = plan.filter((q) => q.phase === 'P3_pressure').map((q) => q.qId);
    expect(p3).toEqual(['p3_incomplete', 'p3_conflict', 'p3_overreach', 'p3_cost_bound']);
    expect(p3.length).toBe(DEFAULT_PER_PHASE.P3_pressure);
  });

  it('每阶段取题数不超过默认上限', () => {
    const plan = selectQuestions({ jobType: 'text' });
    const counts: Record<string, number> = {};
    for (const q of plan) counts[q.phase] = (counts[q.phase] ?? 0) + 1;
    for (const phase of Object.keys(DEFAULT_PER_PHASE)) {
      expect(counts[phase] ?? 0).toBeLessThanOrEqual(
        DEFAULT_PER_PHASE[phase as keyof typeof DEFAULT_PER_PHASE],
      );
    }
  });

  it('含任务占位符的区分性题可被通用问法替换（无需求时）', () => {
    const prompt = renderPrompt('{{需求}}', { qId: 'p2_decisive_task' });
    expect(prompt).not.toContain('{{需求}}');
    expect(prompt).toContain('开工后的前 5 个具体动作');
  });
});
