/**
 * tests/unit/taskMatch.test.ts
 *
 * 任务画像抽取引擎单测（模块 A）：
 *  - inferJobType        —— 图/文/码三工种推断 + 确定性 tie-break + 无命中 null
 *  - extractDimBoost     —— 六类维度强调词典；多规则命中同维「取最大值而非连乘」
 *  - extractTags         —— 标准标签抽取（去重、按词典顺序、含工种标签）
 *  - extractTaskProfile  —— 主入口（含 jobTypeHint 覆盖语义）
 *  - 边界：空串 / 空白 / null / undefined / 纯英文 / 无命中文本
 *
 * 强约束校验：**确定性**（同输入必然同输出，不调模型）。
 * 运行：env -u NODE_OPTIONS npx vitest run tests/unit/taskMatch.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  DIM_BOOST_RULES,
  EMPTY_TASK_PROFILE,
  JOB_KEYWORDS,
  JOB_TAG_LABELS,
  extractDimBoost,
  extractTags,
  extractTaskProfile,
  inferJobType,
} from '@/engine/marketplace/taskMatch';

describe('taskMatch · inferJobType（工种推断）', () => {
  it('命中 code 关键词 → code', () => {
    expect(inferJobType('要一个稳定又便宜的后端 agent')).toBe('code');
    expect(inferJobType('帮我修一个 bug')).toBe('code');
    expect(inferJobType('写个爬虫脚本')).toBe('code');
  });

  it('命中 image 关键词 → image', () => {
    expect(inferJobType('帮我画一张海报，要有创意和设计感')).toBe('image');
    expect(inferJobType('做几张插画配图')).toBe('image');
  });

  it('命中 text 关键词 → text', () => {
    expect(inferJobType('帮我写一篇公众号文案，要高质量')).toBe('text');
    expect(inferJobType('把这份报告润色一下')).toBe('text');
  });

  it('取命中数最多的工种（多工种混合文本）', () => {
    // image 命中 画/海报/配图 = 3；code 仅命中 接口 = 1
    expect(inferJobType('画海报和配图，顺便对接一下接口')).toBe('image');
    // code 命中 开发/接口/部署 = 3；text 仅命中 文 = 1
    expect(inferJobType('开发一个接口并完成部署，写点说明文')).toBe('code');
  });

  it('命中数相同时按 JOB_ORDER（image → text → code）确定性 tie-break', () => {
    // 「画」= image 1 命中，「接口」= code 1 命中 → 取先者 image
    expect(inferJobType('画一个接口')).toBe('image');
  });

  it('无任何命中 → null', () => {
    expect(inferJobType('hello world')).toBeNull();
    expect(inferJobType('随便找个人帮忙')).toBeNull();
  });

  it('边界：空串 / 纯空白 / null / undefined → null', () => {
    expect(inferJobType('')).toBeNull();
    expect(inferJobType('    ')).toBeNull();
    expect(inferJobType(null)).toBeNull();
    expect(inferJobType(undefined)).toBeNull();
  });

  it('英文关键词大小写不敏感（归一化为小写后匹配）', () => {
    expect(inferJobType('Fix this BUG please')).toBe('code');
    expect(inferJobType('implement a REST API endpoint')).toBe('code');
    expect(inferJobType('design a new UI screen')).toBe('image');
  });

  it('[已知局限] 英文短别名 ui/api 按子串匹配，可能被普通英文单词误命中', () => {
    // 'build' 内含子串 'ui' → image 命中 1，'api' → code 命中 1，平局按 JOB_ORDER 取 image。
    // 该行为符合当前实现的确定性约定，但对纯英文需求存在误判风险（已在 QA 报告中作为观察项提出）。
    expect(inferJobType('build a rest api endpoint')).toBe('image');
  });

  it('确定性：同一输入重复调用结果恒等', () => {
    const text = '要一个稳定又便宜的后端 agent';
    expect(inferJobType(text)).toBe(inferJobType(text));
  });
});

describe('taskMatch · extractDimBoost（维度强调词典）', () => {
  it('cost 规则：便宜/省钱/低成本 → cost ×1.5', () => {
    expect(extractDimBoost('要便宜的')).toEqual({ cost: 1.5 });
    expect(extractDimBoost('预算有限，越省越好')).toEqual({ cost: 1.5 });
  });

  it('reliability 规则：稳定/靠谱/不翻车 → reliability ×1.5', () => {
    expect(extractDimBoost('要稳定不翻车')).toEqual({ reliability: 1.5 });
  });

  it('creativity 规则：一条规则同时强调两个维度（creativity 1.4 + quality 1.2）', () => {
    expect(extractDimBoost('要有创意')).toEqual({ creativity: 1.4, quality: 1.2 });
  });

  it('comm / quality / task 规则各自生效', () => {
    expect(extractDimBoost('需要写文档并且及时沟通')).toEqual({ comm: 1.4 });
    expect(extractDimBoost('要求高质量、注意细节')).toEqual({ quality: 1.4 });
    expect(extractDimBoost('希望能独立完成，端到端交付')).toEqual({ task: 1.3 });
  });

  it('多规则命中同一维度 → 取最大值而非连乘（防堆词权重爆炸）', () => {
    // creativity 规则给 quality 1.2；quality 规则给 quality 1.4 → 取 max 1.4（而非 1.2×1.4=1.68）
    const boost = extractDimBoost('要有创意又要高质量');
    expect(boost.quality).toBeCloseTo(1.4, 10);
    expect(boost.creativity).toBeCloseTo(1.4, 10);
  });

  it('多规则命中不同维度 → 各自独立写入', () => {
    const boost = extractDimBoost('要一个稳定又便宜的后端 agent');
    expect(boost).toEqual({ cost: 1.5, reliability: 1.5 });
  });

  it('结果与规则书写顺序无关（取 max 保证确定性）', () => {
    expect(extractDimBoost('高质量的创意')).toEqual(extractDimBoost('创意的高质量'));
  });

  it('边界：空串 / 空白 / null / undefined / 无命中 → 空对象', () => {
    expect(extractDimBoost('')).toEqual({});
    expect(extractDimBoost('   ')).toEqual({});
    expect(extractDimBoost(null)).toEqual({});
    expect(extractDimBoost(undefined)).toEqual({});
    expect(extractDimBoost('hello world')).toEqual({});
  });

  it('所有 boost 系数均 > 1（强调语义，不做降权）', () => {
    for (const rule of DIM_BOOST_RULES) {
      for (const factor of Object.values(rule.boost)) {
        expect(factor).toBeGreaterThan(1);
      }
    }
  });
});

describe('taskMatch · extractTags（标签抽取）', () => {
  it('按词典顺序输出命中标签，并追加工种标签', () => {
    // DIM_BOOST_RULES 顺序：cost → reliability → creativity → comm → quality → task
    expect(extractTags('要一个稳定又便宜的后端 agent')).toEqual(['低成本', '稳定', '代码']);
  });

  it('工种标签使用 JOB_TAG_LABELS 映射', () => {
    expect(extractTags('画一张海报')).toEqual([JOB_TAG_LABELS.image]);
    expect(extractTags('写一篇文案')).toEqual([JOB_TAG_LABELS.text]);
    expect(extractTags('修一个 bug')).toEqual([JOB_TAG_LABELS.code]);
  });

  it('标签去重（同一规则的多个关键词只产出一个标签）', () => {
    const tags = extractTags('又便宜又省钱还要低成本');
    expect(tags).toEqual(['低成本']);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('边界：空串 / null / 无命中 → 空数组', () => {
    expect(extractTags('')).toEqual([]);
    expect(extractTags(null)).toEqual([]);
    expect(extractTags('hello world')).toEqual([]);
  });
});

describe('taskMatch · extractTaskProfile（主入口）', () => {
  it('典型需求：稳定 + 便宜 + 后端 → code / 双维强调 / 三标签', () => {
    const profile = extractTaskProfile('要一个稳定又便宜的后端 agent');
    expect(profile.jobType).toBe('code');
    expect(profile.dimBoost).toEqual({ cost: 1.5, reliability: 1.5 });
    expect(profile.tags).toEqual(['低成本', '稳定', '代码']);
  });

  it('制图需求：创意规则触发双维强调', () => {
    const profile = extractTaskProfile('帮我画一张海报，要有创意和设计感');
    expect(profile.jobType).toBe('image');
    expect(profile.dimBoost.creativity).toBeCloseTo(1.4, 10);
    expect(profile.dimBoost.quality).toBeCloseTo(1.2, 10);
    expect(profile.tags).toEqual(['创意', '制图']);
  });

  it('文案需求：quality 强调', () => {
    const profile = extractTaskProfile('帮我写一篇公众号文案，要高质量');
    expect(profile.jobType).toBe('text');
    expect(profile.dimBoost).toEqual({ quality: 1.4 });
    expect(profile.tags).toEqual(['高质量', '文案']);
  });

  it('jobTypeHint 显式指定时覆盖文本推断', () => {
    const profile = extractTaskProfile('帮我写一篇文案', 'code');
    expect(profile.jobType).toBe('code');
    // 显式工种标签一定进入 tags（否则手动选工种对 tagMatch 无贡献）
    expect(profile.tags).toContain('代码');
  });

  it("jobTypeHint 为 'all' / null / undefined 时回退到文本推断", () => {
    expect(extractTaskProfile('修一个 bug', 'all').jobType).toBe('code');
    expect(extractTaskProfile('修一个 bug', null).jobType).toBe('code');
    expect(extractTaskProfile('修一个 bug').jobType).toBe('code');
  });

  it('jobTypeHint 在文本无工种信号时也能提供工种与标签', () => {
    const profile = extractTaskProfile('帮我做点事', 'image');
    expect(profile.jobType).toBe('image');
    expect(profile.tags).toEqual(['制图']);
  });

  it('边界：空文本 → 等价于 EMPTY_TASK_PROFILE', () => {
    expect(extractTaskProfile('')).toEqual(EMPTY_TASK_PROFILE);
    expect(extractTaskProfile('   ')).toEqual(EMPTY_TASK_PROFILE);
    expect(extractTaskProfile(null)).toEqual(EMPTY_TASK_PROFILE);
    expect(extractTaskProfile(undefined)).toEqual(EMPTY_TASK_PROFILE);
  });

  it('边界：纯英文文本 —— 命中英文别名则出工种，无中文关键词则 dimBoost 为空', () => {
    const profile = extractTaskProfile('implement a REST api endpoint');
    expect(profile.jobType).toBe('code');
    expect(profile.dimBoost).toEqual({});
    expect(profile.tags).toEqual(['代码']);
  });

  it('边界：纯英文且无任何关键词 → 全空画像', () => {
    const profile = extractTaskProfile('hello world, nice to meet you');
    expect(profile.jobType).toBeNull();
    expect(profile.dimBoost).toEqual({});
    expect(profile.tags).toEqual([]);
  });

  it('确定性：同一输入两次调用结果深度相等', () => {
    const text = '要一个稳定又便宜的后端 agent，最好还能写文档';
    expect(extractTaskProfile(text)).toEqual(extractTaskProfile(text));
  });

  it('词典自洽性：三工种关键词表均非空', () => {
    expect(JOB_KEYWORDS.image.length).toBeGreaterThan(0);
    expect(JOB_KEYWORDS.text.length).toBeGreaterThan(0);
    expect(JOB_KEYWORDS.code.length).toBeGreaterThan(0);
  });
});
