import {
  addChatMessage,
  createChatSession,
  getChatSession,
  getSettings,
} from '../../db';
import { getBackgroundTaskRegistry } from '../backgroundTaskRegistry';
import { getHeadlessTaskSupervisor } from '../headlessTaskSupervisor';
import { resolveScopedModelName, type ModelScope } from '../modelScopeSettings';
import { QueryRuntime } from '../queryRuntime';
import {
  ToolConfirmationOutcome,
  ToolExecutor,
  ToolRegistry,
} from '../toolRegistry';
import { createBuiltinTools } from '../tools';
import { normalizeApiBaseUrl } from '../urlUtils';
import { assembleRuntimeSystemPrompt } from './contextAssembler';
import { getRoleSpec } from './roleRegistry';
import { ROLE_SEQUENCE_BY_INTENT, runStructuredSubagent, type SubagentOutput } from './subagentRuntime';
import { getTaskGraphRuntime } from './taskGraphRuntime';
import type { AgentTaskSnapshot, RoleId, RuntimeMode } from './types';
import type { RuntimeEvent } from '../runtimeTypes';
import type { BuiltinToolPack } from '../tools/catalog';

const PREP_ROLE_SEQUENCE_BY_INTENT: Partial<Record<NonNullable<AgentTaskSnapshot['intent']>, RoleId[]>> = {
  manuscript_creation: ['planner', 'researcher', 'copywriter'],
  advisor_persona: ['planner', 'researcher', 'copywriter'],
  cover_generation: ['planner', 'researcher', 'image-director'],
  image_creation: ['planner', 'researcher', 'image-director'],
  knowledge_retrieval: ['planner', 'researcher'],
  long_running_task: ['planner', 'ops-coordinator'],
  automation: ['planner', 'ops-coordinator'],
};

const PREP_ROLE_BATCHES_BY_INTENT: Partial<Record<NonNullable<AgentTaskSnapshot['intent']>, RoleId[][]>> = {
  manuscript_creation: [['planner'], ['researcher'], ['copywriter']],
  advisor_persona: [['planner'], ['researcher'], ['copywriter']],
  cover_generation: [['planner'], ['researcher', 'image-director']],
  image_creation: [['planner'], ['researcher', 'image-director']],
  knowledge_retrieval: [['planner'], ['researcher']],
  long_running_task: [['planner'], ['ops-coordinator']],
  automation: [['planner'], ['ops-coordinator']],
};

const MODEL_SCOPE_BY_MODE: Record<RuntimeMode, ModelScope> = {
  redclaw: 'redclaw',
  knowledge: 'knowledge',
  chatroom: 'chatroom',
  'advisor-discussion': 'chatroom',
  'background-maintenance': 'redclaw',
};

type CoordinatorRunOptions = {
  emitChatEvent?: (channel: string, data: unknown) => void;
  onRuntimeEvent?: (event: RuntimeEvent) => void;
  baseSystemPrompt?: string;
};

type LlmConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs?: number;
};

type SubagentBatchResult = {
  roleId: RoleId;
  output: SubagentOutput;
};

const normalizeRoleSequence = (task: AgentTaskSnapshot): RoleId[] => {
  const byIntent = PREP_ROLE_SEQUENCE_BY_INTENT[task.intent as keyof typeof PREP_ROLE_SEQUENCE_BY_INTENT];
  if (byIntent && byIntent.length > 0) return byIntent;
  const fallback = ROLE_SEQUENCE_BY_INTENT[task.taskType] || [];
  return fallback.filter((roleId) => roleId !== 'reviewer');
};

const normalizeRoleBatches = (task: AgentTaskSnapshot): RoleId[][] => {
  const byIntent = PREP_ROLE_BATCHES_BY_INTENT[task.intent as keyof typeof PREP_ROLE_BATCHES_BY_INTENT];
  if (byIntent && byIntent.length > 0) return byIntent;
  return normalizeRoleSequence(task).map((roleId) => [roleId]);
};

const inferArtifactType = (roleId: RoleId): string => {
  switch (roleId) {
    case 'planner':
      return 'plan';
    case 'researcher':
      return 'research-note';
    case 'copywriter':
      return 'manuscript';
    case 'image-director':
      return 'image-plan';
    case 'ops-coordinator':
      return 'ops-report';
    case 'reviewer':
      return 'review-report';
    default:
      return 'artifact';
  }
};

const normalizeBuiltinPack = (value: string): BuiltinToolPack => {
  if (value === 'redclaw' || value === 'knowledge' || value === 'chatroom' || value === 'diagnostics' || value === 'full') {
    return value;
  }
  return 'redclaw';
};

const shouldUseCoordinator = (task: AgentTaskSnapshot): boolean => {
  return Boolean(task.route?.requiresLongRunningTask || task.route?.requiresMultiAgent);
};

const buildExecutionPrompt = (task: AgentTaskSnapshot, outputs: SubagentOutput[]): string => {
  const sections = [
    `当前任务目标：${task.goal || task.route?.goal || task.taskType}`,
    '',
    '请严格按照以下多角色协作结果执行，不要跳过落盘和工具回执校验：',
    ...outputs.map((output) => {
      const lines = [
        `### ${output.roleId}`,
        `- summary: ${output.summary}`,
      ];
      if (output.artifact) lines.push(`- artifact: ${output.artifact}`);
      if (output.handoff) lines.push(`- handoff: ${output.handoff}`);
      if (output.risks?.length) lines.push(`- risks: ${output.risks.join('；')}`);
      return lines.join('\n');
    }),
    '',
    '执行要求：',
    '- 先完成当前最关键的执行动作，再给出结果。',
    '- 如果形成了稿件、配图方案或自动化动作，必须推动保存或给出真实工具回执。',
    '- 如果工具没有成功，不得宣称成功。',
  ];
  return sections.join('\n');
};

const isReviewerApproved = (review: SubagentOutput): boolean => {
  if (typeof review.approved === 'boolean') return review.approved;
  const raw = (review.raw && typeof review.raw === 'object') ? review.raw as Record<string, unknown> : null;
  if (raw && raw.approved === false) return false;
  if (raw && raw.pass === false) return false;
  const summary = String(review.summary || '').toLowerCase();
  if (summary.includes('未通过') || summary.includes('fail') || summary.includes('不满足')) {
    return false;
  }
  return true;
};

const forwardRuntimeEventToChat = (event: RuntimeEvent, emit?: (channel: string, data: unknown) => void) => {
  if (!emit) return;
  switch (event.type) {
    case 'thinking':
      emit('chat:thought-delta', { content: event.content });
      break;
    case 'response_chunk':
      emit('chat:response-chunk', { content: event.content });
      break;
    case 'response_end':
      emit('chat:response-end', { content: event.content });
      break;
    case 'tool_start':
      emit('chat:tool-start', {
        callId: event.callId,
        name: event.name,
        input: event.params,
        description: event.description,
      });
      break;
    case 'tool_output':
      emit('chat:tool-update', {
        callId: event.callId,
        name: event.name,
        partial: event.chunk,
      });
      break;
    case 'tool_end':
      emit('chat:tool-end', {
        callId: event.callId,
        name: event.name,
        output: {
          success: event.result.success,
          content: event.result.display || event.result.llmContent || event.result.error?.message || '',
        },
      });
      break;
    case 'compact_start':
      emit('chat:thought-delta', { content: `上下文整理中（${event.strategy}）...` });
      break;
    case 'error':
      emit('chat:error', { message: 'AI 请求失败', raw: event.message, hint: event.message });
      break;
    default:
      break;
  }
};

export class LongTaskCoordinator {
  private async runSubagentBatchWithRetry(input: {
    llm: LlmConfig;
    task: AgentTaskSnapshot;
    route: NonNullable<AgentTaskSnapshot['route']>;
    batch: RoleId[];
    priorOutputs: SubagentOutput[];
    backgroundTaskId: string;
    signal: AbortSignal;
    options: CoordinatorRunOptions;
    maxAttempts?: number;
  }): Promise<SubagentBatchResult[]> {
    const runtime = getTaskGraphRuntime();
    const backgroundRegistry = getBackgroundTaskRegistry();
    const maxAttempts = Math.max(1, Number(input.maxAttempts || 2));
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (input.signal.aborted) {
        throw new Error('Coordinator cancelled');
      }
      runtime.addTrace(input.task.id, 'coordinator.batch.attempt', {
        batch: input.batch,
        attempt,
        priorOutputs: input.priorOutputs.length,
      }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
      await backgroundRegistry.appendTurn(input.backgroundTaskId, {
        source: 'system',
        text: `[coordinator] batch ${input.batch.join(',')} attempt ${attempt}/${maxAttempts}`,
      });

      try {
        const results = await Promise.all(input.batch.map(async (roleId) => {
          runtime.addTrace(input.task.id, 'coordinator.role.started', {
            roleId,
            priorOutputs: input.priorOutputs.length,
            batch: input.batch,
            attempt,
          }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
          const output = await runStructuredSubagent({
            llm: input.llm,
            roleId,
            route: input.route,
            runtimeMode: input.task.runtimeMode,
            taskId: input.task.id,
            userInput: input.route.goal,
            priorOutputs: input.priorOutputs,
          });
          return { roleId, output };
        }));
        runtime.addTrace(input.task.id, 'coordinator.batch.succeeded', {
          batch: input.batch,
          attempt,
        }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
        return results;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        runtime.addTrace(input.task.id, 'coordinator.batch.failed', {
          batch: input.batch,
          attempt,
          error: lastError.message,
        }, input.batch.length === 1 && input.batch[0] === 'planner' ? 'plan' : 'spawn_agents');
        await backgroundRegistry.appendTurn(input.backgroundTaskId, {
          source: 'system',
          text: `[coordinator] batch ${input.batch.join(',')} failed on attempt ${attempt}: ${lastError.message}`,
        });
        if (attempt >= maxAttempts) {
          break;
        }
        input.options.onRuntimeEvent?.({
          type: 'thinking',
          phase: 'analyze',
          content: `${input.batch.join(' / ')} 失败，正在重试第 ${attempt + 1} 次...`,
        });
        input.options.emitChatEvent?.('chat:thought-delta', {
          content: `${input.batch.join(' / ')} 失败，正在重试第 ${attempt + 1} 次...`,
        });
      }
    }

    throw lastError || new Error(`subagent batch failed: ${input.batch.join(',')}`);
  }

  async maybeRun(taskId: string, options: CoordinatorRunOptions = {}): Promise<AgentTaskSnapshot | null> {
    const runtime = getTaskGraphRuntime();
    const task = runtime.getTask(taskId);
    if (!task) return null;
    if (!shouldUseCoordinator(task)) {
      return runtime.resumeTask(taskId);
    }

    const llm = this.resolveLlmConfig(task.runtimeMode);
    const backgroundRegistry = getBackgroundTaskRegistry();
    const existingBgTask = await backgroundRegistry.getTask(task.id);
    const backgroundTask = (!existingBgTask || existingBgTask.status !== 'running')
      ? await backgroundRegistry.registerTask({
          kind: 'headless-runtime',
          title: `Coordinator · ${task.goal || task.taskType}`,
          contextId: task.ownerSessionId || task.id,
          sessionId: task.ownerSessionId || undefined,
        })
      : existingBgTask;

    await getHeadlessTaskSupervisor().run({
      taskId: backgroundTask.id,
      title: `Coordinator ${task.goal || task.taskType}`,
      backoff: {
        initialDelayMs: 1000,
        maxDelayMs: 15000,
        maxAttempts: 2,
        giveUpAfterMs: 6 * 60 * 1000,
        timeoutMs: 2 * 60 * 1000,
      },
      execute: async (signal) => {
        await this.executeCoordinatedTask(taskId, backgroundTask.id, llm, signal, options);
        return true;
      },
    });
    return runtime.getTask(taskId);
  }

  private resolveLlmConfig(runtimeMode: RuntimeMode): LlmConfig {
    const settings = (getSettings() || {}) as Record<string, unknown>;
    const apiKey = String(settings.api_key || '').trim();
    const baseURL = normalizeApiBaseUrl(String(settings.api_endpoint || '').trim(), 'https://api.openai.com/v1');
    const model = resolveScopedModelName(settings, MODEL_SCOPE_BY_MODE[runtimeMode], String(settings.model_name || 'gpt-4o-mini'));
    if (!apiKey) {
      throw new Error('Coordinator missing api key');
    }
    return {
      apiKey,
      baseURL,
      model,
      timeoutMs: 45000,
    };
  }

  private ensureOwnerSession(task: AgentTaskSnapshot): string {
    const sessionId = String(task.ownerSessionId || `session_${Date.now()}`).trim();
    if (!getChatSession(sessionId)) {
      createChatSession(sessionId, task.goal || task.taskType, {
        contextType: task.runtimeMode,
        contextId: task.id,
      });
    }
    return sessionId;
  }

  private async executeCoordinatedTask(taskId: string, backgroundTaskId: string, llm: LlmConfig, signal: AbortSignal, options: CoordinatorRunOptions = {}): Promise<void> {
    const runtime = getTaskGraphRuntime();
    const backgroundRegistry = getBackgroundTaskRegistry();
    const task = runtime.getTask(taskId);
    if (!task || !task.route) {
      throw new Error(`Coordinator task not found: ${taskId}`);
    }
    const route = task.route;

    const sessionId = this.ensureOwnerSession(task);
    await backgroundRegistry.attachSession(backgroundTaskId, sessionId);
    options.emitChatEvent?.('chat:thought-start', {});
    await backgroundRegistry.appendTurn(backgroundTaskId, {
      source: 'system',
      text: '[coordinator] long task planning started',
    });

    const prepRoles = normalizeRoleSequence(task);
    const prepRoleBatches = normalizeRoleBatches(task);
    const outputs: SubagentOutput[] = [];

    runtime.addTrace(task.id, 'coordinator.start', {
      route: task.route,
      prepRoles,
      prepRoleBatches,
      runtimeMode: task.runtimeMode,
    }, 'plan');

    for (const batch of prepRoleBatches) {
      if (signal.aborted) {
        throw new Error('Coordinator cancelled');
      }
      const isPlannerBatch = batch.length === 1 && batch[0] === 'planner';
      if (isPlannerBatch) {
        runtime.startNode(task.id, 'plan', 'coordinator planner running');
      } else if (task.graph.some((node) => node.type === 'spawn_agents' && node.status !== 'completed')) {
        runtime.startNode(task.id, 'spawn_agents', `running ${batch.join(',')}`);
      }

      const priorOutputs = [...outputs];
      await Promise.all(batch.map(async (roleId) => {
        await backgroundRegistry.appendTurn(backgroundTaskId, {
          source: 'thought',
          text: `[coordinator] ${roleId} 正在处理`,
        });
        const roleThinkingEvent: RuntimeEvent = { type: 'thinking', phase: 'analyze', content: `${roleId} 正在规划/处理...` };
        options.onRuntimeEvent?.(roleThinkingEvent);
        options.emitChatEvent?.('chat:thought-delta', { content: `${roleId} 正在规划/处理...` });
      }));

      const batchOutputs = await this.runSubagentBatchWithRetry({
        llm,
        task,
        route,
        batch,
        priorOutputs,
        backgroundTaskId,
        signal,
        options,
      });

      for (const { roleId, output } of batchOutputs) {
        outputs.push(output);
        runtime.addCheckpoint(task.id, roleId === 'planner' ? 'plan' : 'spawn_agents', `${roleId}: ${output.summary}`, output);
        runtime.addArtifact(task.id, {
          type: inferArtifactType(roleId),
          label: `${roleId}: ${output.summary.slice(0, 120)}`,
          metadata: output.raw,
        });
        runtime.addTrace(task.id, 'coordinator.role.completed', {
          roleId,
          summary: output.summary,
          handoff: output.handoff,
          risks: output.risks || [],
          approved: output.approved,
          issues: output.issues || [],
          batch,
        }, roleId === 'planner' ? 'plan' : 'spawn_agents');

        if (roleId === 'planner') {
          runtime.completeNode(task.id, 'plan', output.summary);
        } else if (roleId === 'researcher' && task.graph.some((node) => node.type === 'retrieve')) {
          runtime.startNode(task.id, 'retrieve', output.summary);
          runtime.completeNode(task.id, 'retrieve', output.summary);
        }
      }
    }

    if (task.graph.some((node) => node.type === 'spawn_agents')) {
      runtime.completeNode(task.id, 'spawn_agents', `subagents=${prepRoles.filter((roleId) => roleId !== 'planner').join(',')}`);
    }

    const executionPrompt = buildExecutionPrompt(task, outputs);
    const activeRoleId = [...outputs].reverse().find((item) => item.roleId === 'copywriter' || item.roleId === 'image-director' || item.roleId === 'ops-coordinator')?.roleId
      || task.roleId as RoleId
      || task.route.recommendedRole;
    const activeRole = getRoleSpec(activeRoleId);
    const systemPrompt = assembleRuntimeSystemPrompt({
      baseSystemPrompt: options.baseSystemPrompt || '你是 RedBox 的协调执行代理。你接收的是已经过计划和子角色拆解后的任务，必须严格按协作结果执行。',
      runtimeMode: task.runtimeMode,
      route: task.route,
      role: activeRole,
      task,
    });
    const finalSystemPrompt = `${systemPrompt}\n\n## Coordinator Handoff\n${executionPrompt}`;

    addChatMessage({
      id: `coord_user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      role: 'user',
      content: executionPrompt,
    });

    const executionToolPack = normalizeBuiltinPack(activeRole.allowedToolPack);
    const toolRegistry = new ToolRegistry();
    toolRegistry.registerTools(createBuiltinTools({ pack: executionToolPack }));
    const toolExecutor = new ToolExecutor(toolRegistry, async () => ToolConfirmationOutcome.ProceedOnce);

    runtime.startNode(task.id, 'execute_tools', `coordinator executing as ${activeRole.roleId}`);
    const queryRuntime = new QueryRuntime(
      toolRegistry,
      toolExecutor,
      {
        onEvent: (event) => {
          options.onRuntimeEvent?.(event);
          forwardRuntimeEventToChat(event, options.emitChatEvent);
          if (event.type === 'thinking') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'thought', text: event.content });
          } else if (event.type === 'tool_start') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'tool', text: `调用工具：${event.name}` });
          } else if (event.type === 'response_chunk') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'response', text: event.content });
          } else if (event.type === 'error') {
            void backgroundRegistry.appendTurn(backgroundTaskId, { source: 'system', text: `错误：${event.message}` });
          }
        },
      },
      {
        sessionId,
        apiKey: llm.apiKey,
        baseURL: llm.baseURL,
        model: llm.model,
        systemPrompt: finalSystemPrompt,
        messages: [],
        signal,
        maxTurns: task.route.requiresLongRunningTask ? 18 : 12,
        maxTimeMinutes: task.route.requiresLongRunningTask ? 8 : 5,
        temperature: 0.3,
        toolPack: executionToolPack,
        runtimeMode: task.runtimeMode,
        interactive: true,
        requiresHumanApproval: task.route.requiresHumanApproval,
      },
    );
    const execution = await queryRuntime.run(executionPrompt);
    if (execution.error) {
      runtime.failTask(task.id, execution.error, 'execute_tools');
      await backgroundRegistry.failTask(backgroundTaskId, execution.error);
      options.emitChatEvent?.('chat:error', { message: 'AI 请求失败', raw: execution.error, hint: execution.error });
      throw new Error(execution.error);
    }
    runtime.completeNode(task.id, 'execute_tools', `responseLength=${execution.response.length}`);
    addChatMessage({
      id: `coord_assistant_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      session_id: sessionId,
      role: 'assistant',
      content: execution.response,
    });

    if (task.graph.some((node) => node.type === 'handoff')) {
      runtime.startNode(task.id, 'handoff', '整合下一步交接');
      runtime.completeNode(task.id, 'handoff', outputs.map((item) => `${item.roleId}:${item.handoff || item.summary}`).join(' | '));
    }

    if (task.graph.some((node) => node.type === 'review')) {
      runtime.startNode(task.id, 'review', 'reviewer validating coordinated execution');
      const reviewOutput = await runStructuredSubagent({
        llm,
        roleId: 'reviewer',
        route: task.route,
        runtimeMode: task.runtimeMode,
        taskId: task.id,
        userInput: `请审核以下执行结果是否满足目标：\n${execution.response}`,
        priorOutputs: [
          ...outputs,
          {
            roleId: activeRole.roleId,
            summary: execution.response.slice(0, 1200),
            artifact: execution.response,
            handoff: 'review current execution',
            raw: { executionResponse: execution.response },
          },
        ],
      });
      runtime.addCheckpoint(task.id, 'review', reviewOutput.summary, reviewOutput);
      runtime.addArtifact(task.id, {
        type: 'review-report',
        label: `reviewer: ${reviewOutput.summary.slice(0, 120)}`,
        metadata: reviewOutput.raw,
      });
      if (!isReviewerApproved(reviewOutput)) {
        runtime.failTask(task.id, reviewOutput.summary || 'reviewer rejected execution', 'review');
        await backgroundRegistry.failTask(backgroundTaskId, reviewOutput.summary || 'reviewer rejected execution');
        throw new Error(reviewOutput.summary || 'reviewer rejected execution');
      }
      runtime.completeNode(task.id, 'review', reviewOutput.summary);
    }

    if (task.graph.some((node) => node.type === 'save_artifact')) {
      runtime.completeNode(task.id, 'save_artifact', 'coordinator 已记录执行产物');
    }
    runtime.completeTask(task.id, 'Coordinator multi-agent execution completed');
    options.emitChatEvent?.('chat:response-end', { content: execution.response });
    await backgroundRegistry.completeTask(backgroundTaskId, execution.response.slice(0, 240) || 'Coordinator completed');
  }
}

let longTaskCoordinator: LongTaskCoordinator | null = null;

export const getLongTaskCoordinator = (): LongTaskCoordinator => {
  if (!longTaskCoordinator) {
    longTaskCoordinator = new LongTaskCoordinator();
  }
  return longTaskCoordinator;
};
