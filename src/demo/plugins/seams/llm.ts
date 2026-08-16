/**
 * src/demo/plugins/seams/llm.ts —— LLM 能力接入点
 * --------------------------------------------------------------------------
 * LLM 适配 seam：与 dsh Provider 同构——内核只认 LLMProvider 接口，具体实现
 * （ascend-npu / minicpm / 云端 API）以 Provider 形式注册，可替换、可 patch、
 * 可设置 priority 决定默认实现。内核不直接依赖任何 LLM 运行时（对齐
 * 内核不直接依赖任何 LLM 运行时。
 */
import type { CapabilityKind } from '../context';

export const LLM_KIND: CapabilityKind = 'llm';

export interface LLMProvider {
  id: string;
  /** 文本生成；opts 透传温度/最大长度等。失败不抛，由调用方降级。 */
  complete(prompt: string, opts?: Record<string, unknown>): Promise<string>;
}
