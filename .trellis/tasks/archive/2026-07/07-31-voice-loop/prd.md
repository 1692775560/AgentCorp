# PRD：语音闭环（SSE narration/audio 消费 + TTS 播报）

## 背景

README 把「语音讲解 + 语音宣判」列为全模态核心卖点，但评审发现渲染层根本没有消费
narration/audio 事件（judgeClient.parseBlock 只认 radar_update/verdict/done，其余丢弃）。
更进一步，`/api/evaluate-run`（应用实际使用的裁判路径）的 mock 和 real 流
**压根不产生** narration/audio 事件——只有候选路径 /api/evaluate 产生。

## 目标

评估运行时：六维雷达逐维点亮的同时，讲解文本逐句滚动显示并语音播报；
verdict 出来后语音宣判（MVP / 待观察 / You are fired）。Mock / 离线（fallbackMock）
路径同样可用——这是评委演示的主路径。

## 范围

1. **model-service**：`_stream_mock_run` / `_stream_real_run` 增加 narration（逐句 delta）
   与 audio（mock=base64 UTF-8 文本，沿用候选路径 `_encode_text` 语义；real=tts 字节，
   tts 不可用时只发 narration）事件，verdict 后追加语音宣判 audio。
2. **judgeClient**：parseBlock 支持 narration / audio 两种事件（类型契约
   `src/types/evaluation.ts` 的 NarrationEvent/AudioEvent 已存在，直接对齐）；
   fallbackMock 增加 narration 事件（离线演示闭环）。
3. **新增 `src/services/speech.ts`**：
   - `speak(text)`：speechSynthesis 播报（队列串行、可打断）。
   - `playAudioChunk(chunk, format, sampleRate)`：base64 → 字节；RIFF/wav 头走
     AudioContext.decodeAudioData 播放；可打印 UTF-8 文本（mock）走 speak。
   - `setEnabled(false)` 时全部静默；组件卸载/重新评估时可 `cancel()`。
4. **stores/evaluation**：消费新事件——narration 增量累计进 `narrationText` 状态并播报；
   verdict 生成宣判文本播报；新增 `voiceEnabled` 开关与 `narrationText` 状态。
   防双播：同一事件流中若出现 audio 事件则播报权交给 audio，narration 只上屏；
   无 audio 事件（fallbackMock / tts 不可用）则播报 narration 文本。
5. **评估页**：新增「讲解」面板（滚动文本 + 语音开关按钮 + 重新评估时清空）。

## 非目标

- 真实 TTS 模型接入（tts.py 骨架不动）。
- 语音录入偏好（speech recognition）。
- /api/evaluate 候选路径的前端 UI（样本集演示）。

## 验收

- `pnpm typecheck` / `lint` / `test` 全绿；`pytest` 全绿。
- 单测覆盖：parseBlock 解析 narration/audio；speech 服务静音/取消逻辑；
  mock-run 流含 narration+audio+verdict+done。
- test_evaluate_run.py 的"恰好 8 事件"断言同步更新为新事件序列。
