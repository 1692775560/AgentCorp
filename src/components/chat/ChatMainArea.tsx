/**
 * ChatMainArea — 主聊天区（消息流 + 流式渲染 + 输入框）
 * 从 pages/Chat/index.tsx 抽取，首页（Chat）与会话页（Chats）共用，
 * 按 variant 渲染：agent 会话主聊天区 / 团队房间 / 团队任务会话。
 */
import { useState } from 'react';
import { AlertCircle, Loader2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useChatStore, type RawMessage } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { WorkbenchEmptyState } from '@/components/workbench/workbench-empty-state';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { TeamTaskChatView } from '@/pages/Chat/TeamTaskChatView';
import { TeamChatView } from '@/pages/Chat/TeamChatView';
import { extractImages, extractText, extractThinking, extractToolUse } from '@/pages/Chat/message-utils';
import { useStickToBottomInstant } from '@/hooks/use-stick-to-bottom-instant';
import { useMinLoading } from '@/hooks/use-min-loading';

export interface ChatMainAreaProps {
  /** agent：普通 agent 会话；teamRoom：团队房间；teamTask：团队任务会话 */
  variant: 'agent' | 'teamRoom' | 'teamTask';
  /** variant = teamRoom 时的团队 id */
  teamId?: string | null;
  /** variant = teamTask 时的任务 id */
  taskId?: string | null;
}

export function ChatMainArea({ variant, teamId = null, taskId = null }: ChatMainAreaProps) {
  const { t } = useTranslation(['chat', 'common']);

  const messages = useChatStore((s) => s.messages);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const loading = useChatStore((s) => s.loading);
  const sending = useChatStore((s) => s.sending);
  const error = useChatStore((s) => s.error);
  const showThinking = useChatStore((s) => s.showThinking);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingTools = useChatStore((s) => s.streamingTools);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const abortRun = useChatStore((s) => s.abortRun);
  const clearError = useChatStore((s) => s.clearError);

  const agents = useAgentsStore((s) => s.agents);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId) ?? null;
  const isGatewayRunning = useGatewayStore((s) => s.status).state === 'running';

  const minLoading = useMinLoading(loading && messages.length > 0);
  const { contentRef, scrollRef } = useStickToBottomInstant(currentSessionKey);
  const [streamingTimestamp, setStreamingTimestamp] = useState(0);

  const streamMsg = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as { role?: string; content?: unknown; timestamp?: number }
    : null;
  const streamText = streamMsg ? extractText(streamMsg) : (typeof streamingMessage === 'string' ? streamingMessage : '');
  const hasStreamText = streamText.trim().length > 0;
  const streamThinking = streamMsg ? extractThinking(streamMsg) : null;
  const hasStreamThinking = showThinking && !!streamThinking && streamThinking.trim().length > 0;
  const streamTools = streamMsg ? extractToolUse(streamMsg) : [];
  const hasStreamTools = streamTools.length > 0;
  const streamImages = streamMsg ? extractImages(streamMsg) : [];
  const hasStreamImages = streamImages.length > 0;
  const hasStreamToolStatus = streamingTools.length > 0;
  const shouldRenderStreaming = sending && (hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus);
  const hasAnyStreamContent = hasStreamText || hasStreamThinking || hasStreamTools || hasStreamImages || hasStreamToolStatus;

  const isEmpty = messages.length === 0 && !sending;

  const handleSendMessage = (
    text: string,
    attachments?: Parameters<typeof sendMessage>[1],
    targetAgentId?: Parameters<typeof sendMessage>[2],
    workingDir?: Parameters<typeof sendMessage>[3],
  ) => {
    setStreamingTimestamp(Date.now() / 1000);
    sendMessage(text, attachments, targetAgentId, workingDir);
  };

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        {variant === 'teamTask' && taskId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <TeamTaskChatView taskId={taskId} />
          </div>
        ) : variant === 'teamRoom' && teamId ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <TeamChatView teamId={teamId} />
          </div>
        ) : (
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-5">
          <div ref={contentRef} className="mx-auto flex min-h-full w-full max-w-[1000px] flex-col">
            {isEmpty ? (
              <WorkbenchEmptyState />
            ) : (
              <>
                {messages.map((msg, idx) => (
                  <ChatMessage
                    key={msg.id || `msg-${idx}`}
                    message={msg}
                    showThinking={showThinking}
                    agentAvatar={currentAgent?.avatar}
                  />
                ))}

                {shouldRenderStreaming && (
                  <ChatMessage
                    message={(streamMsg
                      ? {
                          ...(streamMsg as Record<string, unknown>),
                          role: (typeof streamMsg.role === 'string' ? streamMsg.role : 'assistant') as RawMessage['role'],
                          content: streamMsg.content ?? streamText,
                          timestamp: streamMsg.timestamp ?? streamingTimestamp,
                        }
                      : {
                          role: 'assistant',
                          content: streamText,
                          timestamp: streamingTimestamp,
                        }) as RawMessage}
                    showThinking={showThinking}
                    isStreaming
                    streamingTools={streamingTools}
                    autoExpandThinking={hasStreamThinking}
                    agentAvatar={currentAgent?.avatar}
                  />
                )}

                {sending && pendingFinal && !shouldRenderStreaming && (
                  <ActivityIndicator phase="tool_processing" />
                )}

                {sending && !pendingFinal && !hasAnyStreamContent && (
                  <TypingIndicator />
                )}
              </>
            )}
          </div>
        </div>
        )}

        {error && (
          <div className="border-t border-destructive/20 bg-destructive/10 px-6 py-2">
            <div className="mx-auto flex max-w-4xl items-center justify-between">
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="h-4 w-4" />
                {error}
              </p>
              <button
                onClick={clearError}
                className="text-xs text-destructive/60 underline hover:text-destructive"
              >
                {t('common:actions.dismiss')}
              </button>
            </div>
          </div>
        )}

        <div className="px-2 pb-2 pt-6">
          {variant === 'agent' && (
          <ChatInput
            onSend={handleSendMessage}
            onStop={abortRun}
            disabled={!isGatewayRunning}
            sending={sending}
            isEmpty={isEmpty}
          />
          )}
        </div>
      </div>

      {minLoading && !sending && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-xl bg-background/20 backdrop-blur-[1px] pointer-events-auto">
          <div className="rounded-full border border-border bg-background p-2.5 shadow-lg">
            <LoadingSpinner size="md" />
          </div>
        </div>
      )}
    </>
  );
}

function TypingIndicator() {
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/5 text-foreground dark:bg-white/5">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="rounded-2xl bg-black/5 px-4 py-3 text-foreground dark:bg-white/5">
        <div className="flex gap-1">
          <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="h-2 w-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    </div>
  );
}

function ActivityIndicator({ phase }: { phase: 'tool_processing' }) {
  void phase;
  return (
    <div className="flex gap-3">
      <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/5 text-foreground dark:bg-white/5">
        <Sparkles className="h-4 w-4" />
      </div>
      <div className="rounded-2xl bg-black/5 px-4 py-3 text-foreground dark:bg-white/5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>工具调用处理中...</span>
        </div>
      </div>
    </div>
  );
}
