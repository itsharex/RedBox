import { addChatMessage, getChatMessages, getSettings } from '../db';
import { PiChatService } from '../pi/PiChatService';
import { QueryRuntime } from './queryRuntime';
import { ToolConfirmationOutcome, ToolExecutor, ToolRegistry } from './toolRegistry';
import { normalizeApiBaseUrl } from './urlUtils';
import { getBackgroundSessionStore } from './backgroundSessionStore';
import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';

type HeadlessRuntimeMode = 'redclaw' | 'background-maintenance';

function createBackgroundEventSink(taskId: string) {
  const registry = getBackgroundTaskRegistry();
  return async (channel: string, data: unknown) => {
    if (channel === 'chat:thought-delta') {
      const text = typeof (data as any)?.content === 'string' ? (data as any).content : '';
      await registry.appendTurn(taskId, { source: 'thought', text });
      return;
    }
    if (channel === 'chat:response-chunk') {
      const text = typeof (data as any)?.content === 'string' ? (data as any).content : '';
      await registry.appendTurn(taskId, { source: 'response', text });
      return;
    }
    if (channel === 'chat:tool-start') {
      const name = typeof (data as any)?.toolName === 'string' ? (data as any).toolName : 'unknown';
      await registry.appendTurn(taskId, { source: 'tool', text: `调用工具：${name}` });
      return;
    }
    if (channel === 'chat:error') {
      const text = typeof (data as any)?.message === 'string' ? (data as any).message : 'unknown error';
      await registry.appendTurn(taskId, { source: 'system', text: `错误：${text}` });
    }
  };
}

export class HeadlessAgentRunner {
  async runRedClawTask(input: {
    taskId: string;
    title: string;
    contextId: string;
    contextContent: string;
    prompt: string;
    displayContent?: string;
    runtimeMode?: HeadlessRuntimeMode;
    service?: PiChatService;
  }): Promise<{ sessionId: string; response: string }> {
    const session = getBackgroundSessionStore().ensureSession({
      contextId: input.contextId,
      contextType: 'redclaw',
      title: input.title,
      contextContent: input.contextContent,
      runtimeMode: input.runtimeMode || 'redclaw',
      metadata: {
        headless: true,
      },
    });
    const registry = getBackgroundTaskRegistry();
    await registry.attachSession(input.taskId, session.id);

    addChatMessage({
      id: `msg_bg_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: session.id,
      role: 'user',
      content: input.prompt,
      display_content: input.displayContent || '[后台任务]',
    });

    const service = input.service || new PiChatService();
    service.setEventSink((channel, data) => {
      void createBackgroundEventSink(input.taskId)(channel, data);
    });
    await service.sendMessage(input.prompt, session.id);
    const latestAssistant = [...getChatMessages(session.id)]
      .reverse()
      .find((msg) => msg.role === 'assistant' && String(msg.content || '').trim());
    return {
      sessionId: session.id,
      response: String(latestAssistant?.content || ''),
    };
  }

  async runJsonRuntimeTask(input: {
    taskId: string;
    title: string;
    contextId: string;
    systemPrompt: string;
    userInput: string;
    model?: string;
    baseURL?: string;
    apiKey?: string;
    maxTurns?: number;
    temperature?: number;
  }): Promise<{ sessionId: string; response: string; error?: string }> {
    const session = getBackgroundSessionStore().ensureSession({
      contextId: input.contextId,
      contextType: 'background-maintenance',
      title: input.title,
      contextContent: input.title,
      runtimeMode: 'background-maintenance',
      metadata: {
        headless: true,
        jsonTask: true,
      },
    });
    const registry = getBackgroundTaskRegistry();
    await registry.attachSession(input.taskId, session.id);

    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = input.apiKey || String(settings.api_key || '').trim();
    const baseURL = normalizeApiBaseUrl(input.baseURL || String(settings.api_endpoint || ''), 'https://api.openai.com/v1');
    const model = input.model || String(settings.model_name || 'gpt-4o-mini');
    const toolRegistry = new ToolRegistry();
    const toolExecutor = new ToolExecutor(
      toolRegistry,
      async () => ToolConfirmationOutcome.ProceedOnce,
    );

    const runtime = new QueryRuntime(toolRegistry, toolExecutor, {
      onEvent: (event) => {
        if (event.type === 'thinking') {
          void registry.appendTurn(input.taskId, { source: 'thought', text: event.content });
        } else if (event.type === 'response_chunk') {
          void registry.appendTurn(input.taskId, { source: 'response', text: event.content });
        } else if (event.type === 'tool_start') {
          void registry.appendTurn(input.taskId, { source: 'tool', text: `调用工具：${event.name}` });
        } else if (event.type === 'error') {
          void registry.appendTurn(input.taskId, { source: 'system', text: `错误：${event.message}` });
        }
      },
    }, {
      sessionId: session.id,
      apiKey,
      baseURL,
      model,
      systemPrompt: input.systemPrompt,
      messages: [],
      maxTurns: input.maxTurns || 8,
      maxTimeMinutes: 5,
      temperature: input.temperature ?? 0.1,
      toolPack: 'background-maintenance',
    });

    const result = await runtime.run(input.userInput);
    return {
      sessionId: session.id,
      response: result.response,
      error: result.error,
    };
  }
}

let headlessAgentRunner: HeadlessAgentRunner | null = null;

export function getHeadlessAgentRunner(): HeadlessAgentRunner {
  if (!headlessAgentRunner) {
    headlessAgentRunner = new HeadlessAgentRunner();
  }
  return headlessAgentRunner;
}
