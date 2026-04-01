import { CompactManager } from './compactManager';
import { executeRuntimeHooks } from './runtimeHooks';
import { getSessionRuntimeStore } from './sessionRuntimeStore';
import { getToolResultStore } from './toolResultStore';
import { applyToolResultBudget } from './toolResultBudget';
import { ToolKind, ToolRegistry, ToolExecutor, type ToolCallRequest, type ToolCallResponse, type ToolResult } from './toolRegistry';
import { normalizeApiBaseUrl, safeUrlJoin } from './urlUtils';
import type { RuntimeAdapter, RuntimeConfig, RuntimeMessage } from './runtimeTypes';

type LlmToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type LlmResponse = {
  content: string;
  toolCalls: LlmToolCall[];
  finishReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

const now = () => Date.now();
const nextId = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const isToolConcurrencySafe = (registry: ToolRegistry, toolName: string, args: Record<string, unknown>): boolean => {
  const tool = registry.getTool(toolName);
  if (!tool) return false;
  if (tool.requiresConfirmation) {
    return false;
  }
  try {
    if (typeof tool.isConcurrencySafe === 'function') {
      return Boolean(tool.isConcurrencySafe(args));
    }
  } catch {
    return false;
  }
  return tool.kind === ToolKind.Read || tool.kind === ToolKind.Search || tool.kind === ToolKind.Fetch;
};

const toToolFeedbackMessage = (name: string, content: string): RuntimeMessage => ({
  role: 'user',
  content: `Tool result from ${name}:\n${content}`,
});

const extractAssistantText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          return typeof record.text === 'string' ? record.text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
};

export class QueryRuntime {
  private readonly store = getSessionRuntimeStore();
  private readonly toolResults = getToolResultStore();
  private readonly compactManager: CompactManager;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly executor: ToolExecutor,
    private readonly adapter: RuntimeAdapter,
    private readonly config: RuntimeConfig,
  ) {
    this.compactManager = new CompactManager({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
    });
  }

  async run(userInput: string): Promise<{ response: string; error?: string }> {
    const startedAt = now();
    const maxTurns = this.config.maxTurns || 24;
    const maxTimeMs = (this.config.maxTimeMinutes || 12) * 60 * 1000;

    let messages: RuntimeMessage[] = [
      { role: 'system', content: this.config.systemPrompt },
      ...this.config.messages,
      { role: 'user', content: userInput },
    ];

    this.adapter.onEvent({ type: 'query_start', sessionId: this.config.sessionId, message: userInput });
    this.store.appendTranscript({
      sessionId: this.config.sessionId,
      recordType: 'query.user',
      role: 'user',
      content: userInput,
      payload: { kind: 'query.user', data: { toolPack: this.config.toolPack } },
    });
    this.store.addCheckpoint({
      sessionId: this.config.sessionId,
      checkpointType: 'query.start',
      summary: '用户消息已进入统一运行时',
      payload: { model: this.config.model, toolPack: this.config.toolPack },
    });

    await executeRuntimeHooks({
      event: 'query.before',
      context: {
        sessionId: this.config.sessionId,
        event: 'query.before',
        payload: { message: userInput, model: this.config.model },
      },
      adapter: this.adapter,
      llm: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
    });

    let turnCount = 0;
    let responseText = '';
    let reactiveCompactUsed = false;
    let continuationCount = 0;
    let lastContinuationDelta = 0;
    let compactFailureCount = 0;

    while (turnCount < maxTurns) {
      if (now() - startedAt > maxTimeMs) {
        const message = 'Query runtime timeout';
        this.adapter.onEvent({ type: 'error', message });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'stop.failure',
          summary: message,
          payload: { turnCount },
        });
        await executeRuntimeHooks({
          event: 'stop.failure',
          context: {
            sessionId: this.config.sessionId,
            event: 'stop.failure',
            payload: { message, turnCount },
          },
          adapter: this.adapter,
        });
        return { response: responseText, error: message };
      }
      if (this.config.signal?.aborted) {
        const message = 'Query runtime cancelled';
        this.adapter.onEvent({ type: 'error', message });
        return { response: responseText, error: message };
      }

      turnCount += 1;
      this.adapter.onEvent({ type: 'thinking', phase: 'analyze', content: `Turn ${turnCount}: analyzing current objective` });
      let compacted = null;
      try {
        if (compactFailureCount < 3) {
          compacted = await this.compactManager.maybeCompact(messages);
        }
      } catch (error) {
        compactFailureCount += 1;
        const compactError = error instanceof Error ? error.message : String(error);
        this.adapter.onEvent({
          type: 'tool_summary',
          toolName: 'runtime.compact',
          content: `compact attempt failed (${compactFailureCount}/3): ${compactError}`,
        });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'query.compact.failure',
          role: 'system',
          content: compactError,
          payload: {
            kind: 'query.compact.failure',
            data: {
              failures: compactFailureCount,
            },
          },
        });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'compact.failure',
          summary: compactError,
          payload: {
            failures: compactFailureCount,
          },
        });
      }
      if (compacted) {
        compactFailureCount = 0;
        this.adapter.onEvent({ type: 'compact_start', strategy: compacted.strategy });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'query.compact',
          role: 'system',
          content: compacted.summary,
          payload: { kind: 'query.compact', data: { strategy: compacted.strategy } },
        });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'compact',
          summary: `${compacted.strategy} compact applied`,
          payload: { strategy: compacted.strategy, summary: compacted.summary },
        });
        messages = compacted.compactedMessages;
        this.adapter.onEvent({ type: 'compact_end', strategy: compacted.strategy, summary: compacted.summary, compacted: true });
      }

      let llmResponse: LlmResponse;
      try {
        llmResponse = await this.callLlm(messages);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const normalized = message.toLowerCase();
        if (!reactiveCompactUsed && (normalized.includes('context_length_exceeded') || normalized.includes('prompt too long') || normalized.includes('maximum context'))) {
          reactiveCompactUsed = true;
          const reactive = await this.compactManager.maybeCompact([
            ...messages,
            { role: 'system', content: 'Reactive compaction requested after context overflow.' },
          ]);
          if (reactive) {
            messages = reactive.compactedMessages;
            this.adapter.onEvent({ type: 'compact_start', strategy: 'reactive' });
            this.adapter.onEvent({ type: 'compact_end', strategy: 'reactive', summary: reactive.summary, compacted: true });
            continue;
          }
        }
        this.adapter.onEvent({ type: 'error', message });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'stop.failure',
          summary: message,
          payload: { turnCount },
        });
        await executeRuntimeHooks({
          event: 'stop.failure',
          context: {
            sessionId: this.config.sessionId,
            event: 'stop.failure',
            payload: { message, turnCount },
          },
          adapter: this.adapter,
        });
        return { response: responseText, error: message };
      }

      if (llmResponse.toolCalls.length > 0) {
        messages.push({ role: 'assistant', content: llmResponse.content || '' });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'assistant.tool_call',
          role: 'assistant',
          content: llmResponse.content || '',
          payload: {
            kind: 'assistant.tool_call',
            data: {
              calls: llmResponse.toolCalls.map((call) => ({ id: call.id, name: call.name, args: call.args })),
            },
          },
        });
        this.adapter.onEvent({ type: 'thinking', phase: 'tooling', content: `Turn ${turnCount}: executing ${llmResponse.toolCalls.length} tool call(s)` });
        const toolResponses = await this.executeToolCalls(llmResponse.toolCalls);
        const budgetedResults = applyToolResultBudget(
          this.registry,
          toolResponses.map((toolResponse) => ({
            toolName: toolResponse.name,
            result: toolResponse.result,
          })),
        );
        messages.push(
          ...budgetedResults.map((toolResult) => toToolFeedbackMessage(toolResult.toolName, toolResult.promptText)),
        );
        for (const [index, toolResult] of budgetedResults.entries()) {
          const response = toolResponses[index];
          const persisted = response
            ? this.toolResults.applyBudget({
                sessionId: this.config.sessionId,
                callId: response.callId,
                promptText: toolResult.promptText,
                originalChars: toolResult.originalChars,
                promptChars: toolResult.promptChars,
                truncated: toolResult.truncated,
              })
            : null;
          if (!toolResult.truncated) {
            continue;
          }
          this.adapter.onEvent({
            type: 'tool_summary',
            toolName: toolResult.toolName,
            content: `tool result budget applied: ${toolResult.originalChars} -> ${toolResult.promptChars} chars`,
          });
          this.store.appendTranscript({
            sessionId: this.config.sessionId,
            recordType: 'tool.result.budget',
            role: 'system',
            content: `tool=${toolResult.toolName}; original=${toolResult.originalChars}; prompt=${toolResult.promptChars}`,
            payload: {
              kind: 'tool.result.budget',
              data: {
                callId: response?.callId,
                toolResultId: persisted?.id,
                toolName: toolResult.toolName,
                originalChars: toolResult.originalChars,
                promptChars: toolResult.promptChars,
              },
            },
          });
        }
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'tool.batch',
          summary: `Completed ${toolResponses.length} tool call(s)`,
          payload: {
            tools: toolResponses.map((toolResponse) => ({
              name: toolResponse.name,
              success: toolResponse.result.success,
            })),
          },
        });
        continue;
      }

      responseText = llmResponse.content || '';
      this.adapter.onEvent({ type: 'thinking', phase: 'respond', content: `Turn ${turnCount}: preparing final response` });
      if (responseText) {
        this.adapter.onEvent({ type: 'response_chunk', content: responseText });
      }
      const shouldContinueForLength =
        llmResponse.finishReason === 'length' &&
        continuationCount < 3 &&
        !(continuationCount >= 2 && responseText.length <= 500 && lastContinuationDelta <= 500);
      if (shouldContinueForLength) {
        continuationCount += 1;
        lastContinuationDelta = responseText.length;
        messages.push({ role: 'assistant', content: responseText });
        const continuationPrompt = `Continue exactly from where you stopped. Do not repeat prior content. This is continuation ${continuationCount}.`;
        messages.push({ role: 'user', content: continuationPrompt });
        this.store.appendTranscript({
          sessionId: this.config.sessionId,
          recordType: 'assistant.partial',
          role: 'assistant',
          content: responseText,
          payload: {
            kind: 'assistant.partial',
            data: {
              turnCount,
              continuationCount,
              finishReason: llmResponse.finishReason,
              usage: llmResponse.usage || null,
            },
          },
        });
        this.store.addCheckpoint({
          sessionId: this.config.sessionId,
          checkpointType: 'response.continue',
          summary: `response continuation requested (${continuationCount})`,
          payload: {
            finishReason: llmResponse.finishReason,
            usage: llmResponse.usage || null,
          },
        });
        this.adapter.onEvent({
          type: 'thinking',
          phase: 'respond',
          content: `Response hit model output limit, continuing (${continuationCount}/3)`,
        });
        continue;
      }
      this.adapter.onEvent({ type: 'response_end', content: responseText });
      this.adapter.onEvent({ type: 'done', response: responseText });
      this.store.appendTranscript({
        sessionId: this.config.sessionId,
        recordType: 'assistant.response',
        role: 'assistant',
        content: responseText,
        payload: { kind: 'assistant.response', data: { turnCount } },
      });
      this.store.addCheckpoint({
        sessionId: this.config.sessionId,
        checkpointType: 'response.final',
        summary: responseText.slice(0, 240) || 'Assistant response completed',
        payload: { turnCount, responseLength: responseText.length },
      });
      await executeRuntimeHooks({
        event: 'query.after',
        context: {
          sessionId: this.config.sessionId,
          event: 'query.after',
          payload: { response: responseText, turnCount },
        },
        adapter: this.adapter,
        llm: {
          apiKey: this.config.apiKey,
          baseURL: this.config.baseURL,
          model: this.config.model,
        },
      });
      return { response: responseText };
    }

    const message = 'Query runtime exceeded max turns';
    this.adapter.onEvent({ type: 'error', message });
    return { response: responseText, error: message };
  }

  private async callLlm(messages: RuntimeMessage[]): Promise<LlmResponse> {
    const response = await fetch(safeUrlJoin(normalizeApiBaseUrl(this.config.baseURL), '/chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal: this.config.signal,
      body: JSON.stringify({
        model: this.config.model,
        temperature: this.config.temperature ?? 0.5,
        messages,
        tools: this.registry.getToolSchemas(),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Runtime LLM error (${response.status}): ${errorText || response.statusText}`);
    }

    const data = await response.json() as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | Array<{ text?: string }>;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
    };
    const message = data?.choices?.[0]?.message;
    return {
      content: extractAssistantText(message?.content),
      toolCalls: Array.isArray(message?.tool_calls)
        ? message!.tool_calls!.map((toolCall) => ({
            id: String(toolCall.id || nextId('tool')),
            name: String(toolCall.function?.name || ''),
            args: (() => {
              try {
                return JSON.parse(String(toolCall.function?.arguments || '{}')) as Record<string, unknown>;
              } catch {
                return {};
              }
            })(),
          })).filter((toolCall) => toolCall.name)
        : [],
      finishReason: typeof data?.choices?.[0]?.finish_reason === 'string'
        ? data.choices?.[0]?.finish_reason
        : undefined,
      usage: data?.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
    };
  }

  private async executeToolCalls(toolCalls: LlmToolCall[]): Promise<ToolCallResponse[]> {
    const serial: LlmToolCall[] = [];
    const responses: ToolCallResponse[] = [];
    let currentConcurrentBatch: LlmToolCall[] = [];
    const flushConcurrentBatch = async () => {
      if (currentConcurrentBatch.length === 0) {
        return;
      }
      responses.push(...await Promise.all(currentConcurrentBatch.map((toolCall) => this.executeSingleToolCall(toolCall))));
      currentConcurrentBatch = [];
    };

    for (const toolCall of toolCalls) {
      if (isToolConcurrencySafe(this.registry, toolCall.name, toolCall.args)) {
        currentConcurrentBatch.push(toolCall);
        continue;
      }
      await flushConcurrentBatch();
      serial.push(toolCall);
    }
    await flushConcurrentBatch();
    for (const toolCall of serial) {
      responses.push(await this.executeSingleToolCall(toolCall));
    }
    return responses;
  }

  private async executeSingleToolCall(toolCall: LlmToolCall): Promise<ToolCallResponse> {
    const tool = this.registry.getTool(toolCall.name);
    const description = tool?.getDescription(toolCall.args) || `Executing ${toolCall.name}`;

    await executeRuntimeHooks({
      event: 'tool.before',
      context: {
        sessionId: this.config.sessionId,
        event: 'tool.before',
        payload: {
          name: toolCall.name,
          args: toolCall.args,
        },
      },
      adapter: this.adapter,
      llm: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
    });

    this.adapter.onEvent({
      type: 'tool_start',
      callId: toolCall.id,
      name: toolCall.name,
      params: toolCall.args,
      description,
    });

    const request: ToolCallRequest = {
      callId: toolCall.id,
      name: toolCall.name,
      params: toolCall.args,
    };
    const response = await this.executor.execute(
      request,
      this.config.signal ?? new AbortController().signal,
      (chunk) => {
        this.adapter.onEvent({
          type: 'tool_output',
          callId: toolCall.id,
          name: toolCall.name,
          chunk,
        });
      },
    );

    const summarized = this.summarizeToolResult(toolCall.name, response.result);
    const persistedToolResult = this.toolResults.add({
      sessionId: this.config.sessionId,
      callId: response.callId,
      toolName: toolCall.name,
      command: this.extractCommand(toolCall.args),
      result: response.result,
      summaryText: summarized,
      payload: {
        durationMs: response.durationMs,
      },
    });
    if (summarized) {
      this.adapter.onEvent({
        type: 'tool_summary',
        toolName: toolCall.name,
        content: summarized,
      });
    }

    this.adapter.onEvent({
      type: 'tool_end',
      callId: response.callId,
      name: response.name,
      result: response.result,
      durationMs: response.durationMs,
    });

    this.adapter.onToolResult?.(toolCall.name, response.result, this.extractCommand(toolCall.args));
    this.store.appendTranscript({
      sessionId: this.config.sessionId,
      recordType: 'tool.result',
      role: 'tool',
      content: summarized || response.result.llmContent,
      payload: {
        kind: 'tool.result',
        data: {
          toolResultId: persistedToolResult.id,
          callId: response.callId,
          toolName: toolCall.name,
          success: response.result.success,
          durationMs: response.durationMs,
        },
      },
    });

    await executeRuntimeHooks({
      event: 'tool.after',
      context: {
        sessionId: this.config.sessionId,
        event: 'tool.after',
        payload: {
          name: toolCall.name,
          args: toolCall.args,
          success: response.result.success,
          output: summarized || response.result.llmContent,
        },
      },
      adapter: this.adapter,
      llm: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
    });

    return response;
  }

  private summarizeToolResult(toolName: string, result: ToolResult): string | null {
    const override = this.adapter.summarizeToolResult?.(toolName, result);
    if (override) return override;
    const text = String(result.llmContent || result.display || result.error?.message || '').trim();
    if (!text) return null;
    if (text.length <= 4_000) return text;
    return `${text.slice(0, 4_000)}\n\n[tool result summarized for runtime event]`;
  }

  private extractCommand(args: Record<string, unknown>): string {
    return typeof args.command === 'string' ? args.command : '';
  }
}
