/**
 * tests/unit/speech.test.ts
 *
 * 语音播放服务单测：Node 环境无 window，全部方法应安全 no-op；
 * 带 jsdom 风格 window mock 时验证 speak/cancel/setEnabled 行为。
 *
 * 运行：pnpm test
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { speech } from '@/services/speech';

describe('speech（无 DOM 环境）', () => {
  it('speak / playAudioChunk / cancel 均安全 no-op', async () => {
    expect(() => speech.speak('测试')).not.toThrow();
    await expect(speech.playAudioChunk('5L2g5aW9', 'wav', 16000)).resolves.toBeUndefined();
    expect(() => speech.cancel()).not.toThrow();
  });

  it('setEnabled(false) 后 isEnabled 为 false', () => {
    speech.setEnabled(false);
    expect(speech.isEnabled()).toBe(false);
    speech.setEnabled(true);
    expect(speech.isEnabled()).toBe(true);
  });
});

describe('speech（带 window mock）', () => {
  const speakMock = vi.fn();
  const cancelMock = vi.fn();
  const getVoicesMock = vi.fn(() => []);

  beforeEach(() => {
    speakMock.mockClear();
    cancelMock.mockClear();
    vi.stubGlobal('window', {
      speechSynthesis: {
        speak: speakMock,
        cancel: cancelMock,
        getVoices: getVoicesMock,
      },
    });
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string;
        lang = '';
        rate = 1;
        voice: unknown = null;
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    speech.setEnabled(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('speak 调用 speechSynthesis.speak，zh-CN，rate 1.05', () => {
    speech.speak('综合判定：MVP。');
    expect(speakMock).toHaveBeenCalledTimes(1);
    const utterance = speakMock.mock.calls[0][0];
    expect(utterance.text).toBe('综合判定：MVP。');
    expect(utterance.lang).toBe('zh-CN');
    expect(utterance.rate).toBe(1.05);
  });

  it('setEnabled(false) 后 speak 静默；cancel 调用 speechSynthesis.cancel', () => {
    speech.setEnabled(false);
    speech.speak('不应播报');
    expect(speakMock).not.toHaveBeenCalled();
    expect(cancelMock).toHaveBeenCalled(); // setEnabled(false) 内部会 cancel
  });

  it('空白文本不播报', () => {
    speech.speak('   ');
    expect(speakMock).not.toHaveBeenCalled();
  });

  it('UTF-8 文本 audio 块（mock 语义）转 speak 播报', async () => {
    // '讲解文本' 的 base64
    const chunk = btoa(unescape(encodeURIComponent('讲解文本')));
    await speech.playAudioChunk(chunk, 'wav', 16000);
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(speakMock.mock.calls[0][0].text).toBe('讲解文本');
  });

  it('含 NUL 控制字符的 pcm16 裸流不会被误判为文本播报', async () => {
    // pcm16 音频数据常含大量 NUL；NUL 是合法 UTF-8（控制字符），
    // 仅靠 trim() 非空会误判为文本 —— 必须被可打印性检查拦下
    const bin = String.fromCharCode(0x00, 0x01, 0x02, 0x03, 0x1f, 0x00, 0x07, 0x00);
    await speech.playAudioChunk(btoa(bin), 'pcm16', 16000);
    expect(speakMock).not.toHaveBeenCalled();
  });
});
