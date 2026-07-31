/**
 * src/services/speech.ts
 * 语音闭环播放服务（评估讲解 + 宣判）。
 *
 * 两条播放路径：
 * - speak(text)：浏览器 speechSynthesis（Mock / 离线路径的语音来源）。
 * - playAudioChunk(chunk, format, sampleRate)：base64 音频块播放——
 *   RIFF/wav 走 AudioContext.decodeAudioData；可打印 UTF-8 文本块
 *   （model-service Mock 的 _encode_text 语义）转 speak；其余按 pcm16 播放。
 *
 * 无 window / AudioContext（单测 Node 环境）时全部安全 no-op。
 */

let enabled = true;
let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;

/** 全局开关（评估页语音按钮） */
export function setEnabled(on: boolean): void {
  enabled = on;
  if (!on) cancel();
}

export function isEnabled(): boolean {
  return enabled;
}

function hasDom(): boolean {
  return typeof window !== 'undefined';
}

/** 停止所有进行中的播报/播放（重新评估或关闭语音时调用） */
export function cancel(): void {
  if (hasDom() && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (currentSource) {
    try {
      currentSource.stop();
    } catch {
      // 已停止的 source 重复 stop 会抛 InvalidStateError，忽略
    }
    currentSource = null;
  }
}

/** TTS 播报（中文 voice 优先；串行排队由 speechSynthesis 自身保证） */
export function speak(text: string): void {
  if (!enabled || !text.trim()) return;
  if (!hasDom() || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'zh-CN';
  utterance.rate = 1.05;
  const zhVoice = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang.toLowerCase().startsWith('zh'));
  if (zhVoice) utterance.voice = zhVoice;
  window.speechSynthesis.speak(utterance);
}

function base64ToBytes(chunk: string): Uint8Array | null {
  try {
    const bin = atob(chunk);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function getAudioContext(): AudioContext | null {
  if (!hasDom()) return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  return audioCtx;
}

async function playBuffer(buffer: AudioBuffer): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return;
    }
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  currentSource = source;
  source.start();
}

/** pcm16 裸流手动拼 AudioBuffer */
async function playPcm16(bytes: Uint8Array, sampleRate: number): Promise<void> {
  const ctx = getAudioContext();
  if (!ctx) return;
  const frameCount = Math.floor(bytes.byteLength / 2);
  if (frameCount === 0) return;
  const buffer = ctx.createBuffer(1, frameCount, sampleRate);
  const channel = buffer.getChannelData(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < frameCount; i++) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }
  await playBuffer(buffer);
}

/**
 * 播放一个 audio 事件块。
 * 判定顺序：RIFF 头 → wav 解码；可打印 UTF-8 文本（Mock）→ speak；其余 → pcm16。
 */
export async function playAudioChunk(
  chunk: string,
  format: 'pcm16' | 'wav',
  sampleRate: number,
): Promise<void> {
  if (!enabled || !chunk) return;
  const bytes = base64ToBytes(chunk);
  if (!bytes || bytes.byteLength === 0) return;

  // 1) RIFF/wav
  if (
    bytes.byteLength > 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 // F
  ) {
    const ctx = getAudioContext();
    if (!ctx) return;
    try {
      const buffer = await ctx.decodeAudioData(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
      await playBuffer(buffer);
    } catch {
      // 损坏的 wav：静默跳过，不中断事件流
    }
    return;
  }

  // 2) 可打印 UTF-8 文本（model-service Mock 的 _encode_text）
  // 注意必须是「可打印」判定：pcm16 裸流常含大量 NUL，而 NUL 本身是合法
  // UTF-8，仅靠 trim() 非空会把音频数据误判成文本念出乱码。
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 排除 C0/C1 控制字符（\t \n \r 除外），剩下的才算可打印文本
    // eslint-disable-next-line no-control-regex
    const hasControl = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(text);
    if (!hasControl && text.trim()) {
      speak(text);
      return;
    }
  } catch {
    // 非 UTF-8：落入 pcm16
  }

  // 3) pcm16 裸流
  if (format === 'pcm16') {
    await playPcm16(bytes, sampleRate);
  }
}

export const speech = { setEnabled, isEnabled, speak, playAudioChunk, cancel };
