# 设计：语音闭环

## 事件流契约（补齐后）

```
radar_update ×6
narration(delta) ×N        ← 新增（mock-run / real-run / fallbackMock）
audio(chunk) ×N            ← 新增（mock-run：base64 文本；real-run：tts 字节，可缺省）
verdict
audio(宣判) ×1             ← 新增
done
```

防双播规则（渲染层）：流中出现过 audio 事件 → narration 只上屏不播报；
否则 narration 文本直接 speak。宣判总是播报（audio 宣判块优先，否则合成文本）。

## model-service 改动（evaluator.py）

- `_stream_mock_run`：雷达逐维后，根据 radar/verdict 生成中文讲解稿
  （模板：总体评价 + 最强维 + 最弱维），逐句 yield narration + audio(_encode_text(句))；
  verdict 后 yield 宣判 audio（"综合判定：X。用户契合度 Y%。"）。
- `_stream_real_run`：parse_output 已产出 narration/audio_script——逐句 yield narration，
  tts_bridge.synthesize 非空时 yield audio；verdict 后同理补宣判（tts 空则跳过 audio）。
- 测试更新：test_evaluate_run.py 的 8 事件断言 → 按类型计数（radar=6, verdict=1, done=1,
  narration≥1, audio≥1）；新增"audio chunk 可 base64 解码"断言。

## 渲染层改动

### judgeClient.parseBlock
新增两个分支（字段对齐 types/evaluation.ts）：
- narration: `{ type:'narration', delta:String, is_final:Boolean }`
- audio: `{ type:'audio', chunk:String, format:'pcm16'|'wav', sample_rate:Number }`

fallbackMock 在雷达逐维后 yield 2-3 条 narration（由 KPI 生成讲解文本），不发 audio
（离线路径走 narration 播报分支）。

### src/services/speech.ts（新）
```ts
setEnabled(on: boolean): void
isEnabled(): boolean
speak(text: string): void            // speechSynthesis，中文 voice 优先，rate 1.05
playAudioChunk(chunk, format, sampleRate): Promise<void>
cancel(): void                       // speechSynthesis.cancel + 停当前 AudioBufferSource
```
playAudioChunk 判定：base64 解码后前 4 字节为 'RIFF' → decodeAudioData；
否则尝试 TextDecoder fatal 解码为 UTF-8 → 可打印则 speak 文本；都失败则按 pcm16
手动拼 AudioBuffer 播放。无 window/AudioContext（单测 node 环境）时安全 no-op。

### stores/evaluation
新增状态：`narrationText: string`、`narrationActive: boolean`、`voiceEnabled: boolean`、
`toggleVoice()`。runEvaluation 开始时 `speech.cancel()` + 清空 narrationText。
事件循环新增分支：narration → 追加文本 + （无 audio 出现时）speak(delta)；
audio → 标记 sawAudio + playAudioChunk；verdict → 若本次流无 audio 宣判块则
speak(合成宣判文本)。实现细节：用局部变量 sawAudio 跟踪本次流。

### pages/Evaluation/index.tsx
- PANELS 增加 `{ key: 'narration', label: '讲解' }`。
- 面板内容：narrationText 滚动区（空态提示）+ 右上角语音开关（Volume2/VolumeX 图标）。
- 头部或面板内显示播报状态。

## 测试

- judgeClient.test.ts：parseBlock narration/audio 用例（经 fallbackMock 或新增直接导出? 
  parseBlock 未导出——通过对 fallbackMock 事件流断言 narration 存在即可，
  另补一个对 mock SSE 文本流的 parseSseStream 级用例可选）。
- 新增 tests/unit/speech.test.ts：mock speechSynthesis / AudioContext，
  验证 setEnabled 静默、cancel 调用、文本块走 speak、RIFF 块走 decodeAudioData。
- pytest：更新 test_evaluate_run.py 事件计数断言 + audio base64 可解码断言。
