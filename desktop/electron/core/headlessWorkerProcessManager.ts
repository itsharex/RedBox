import { app } from 'electron';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';
import { evaluateRuntimeToolPermission } from './runtimePermissions';
import { applyToolResultBudget } from './toolResultBudget';
import { getSessionRuntimeStore } from './sessionRuntimeStore';
import { getToolResultStore } from './toolResultStore';
import {
  createErrorResult,
  ToolErrorType,
  ToolConfirmationOutcome,
  ToolExecutor,
  ToolRegistry,
  type ToolCallRequest,
  type ToolCallResponse,
} from './toolRegistry';
import { createBuiltinTools } from './tools';
import type { BuiltinToolPack } from './tools/catalog';

type JsonWorkerResult = {
  response: string;
  usage?: unknown;
  finishReason?: string | null;
};

type RuntimeWorkerResult = {
  response: string;
  usage?: unknown;
  finishReason?: string | null;
};

type HostedToolFeedback = {
  toolName: string;
  promptText: string;
  success: boolean;
};

type PendingJsonRun = {
  runId: string;
  taskId: string;
  sessionId: string;
  rollback?: () => Promise<void> | void;
  attemptSignal?: AbortSignal;
  resolve: (value: JsonWorkerResult) => void;
  reject: (reason?: unknown) => void;
};

type PendingRuntimeRun = {
  runId: string;
  taskId: string;
  sessionId: string;
  toolPack: BuiltinToolPack;
  runtimeMode?: string;
  requiresHumanApproval?: boolean;
  rollback?: () => Promise<void> | void;
  attemptSignal?: AbortSignal;
  toolAbortController: AbortController;
  resolve: (value: RuntimeWorkerResult) => void;
  reject: (reason?: unknown) => void;
};

type WorkerMode = 'child-json-worker' | 'child-runtime-worker';

type ToolCallMessage = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveWorkerPath(fileName: string): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'workers', fileName);
  }
  return path.join(app.getAppPath(), 'electron', 'workers', fileName);
}

function createWorker(mode: WorkerMode, fileName: string): ChildProcess {
  return spawn(process.execPath, [resolveWorkerPath(fileName)], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

export class HeadlessWorkerProcessManager {
  private readonly runtimeStore = getSessionRuntimeStore();
  private readonly toolResultStore = getToolResultStore();

  private jsonWorker: ChildProcess | null = null;
  private jsonWorkerReady = false;
  private currentJsonRun: PendingJsonRun | null = null;
  private jsonQueue: Array<() => void> = [];
  private jsonReadyResolvers: Array<() => void> = [];

  private runtimeWorker: ChildProcess | null = null;
  private runtimeWorkerReady = false;
  private currentRuntimeRun: PendingRuntimeRun | null = null;
  private runtimeQueue: Array<() => void> = [];
  private runtimeReadyResolvers: Array<() => void> = [];

  private async ensureJsonWorker(): Promise<ChildProcess> {
    if (this.jsonWorker && !this.jsonWorker.killed && this.jsonWorkerReady) {
      return this.jsonWorker;
    }

    const child = createWorker('child-json-worker', 'json-runtime-worker.mjs');
    this.jsonWorker = child;
    this.jsonWorkerReady = false;

    child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        this.jsonWorkerReady = true;
        for (const resolve of this.jsonReadyResolvers.splice(0)) {
          resolve();
        }
        return;
      }

      if (message.type === 'heartbeat') {
        const run = this.currentJsonRun;
        if (run && (!message.runId || message.runId === run.runId)) {
          void getBackgroundTaskRegistry().updateWorkerProcess(run.taskId, {
            workerMode: 'child-json-worker',
            workerPid: child.pid || undefined,
            heartbeatAt: new Date().toISOString(),
          });
        }
        return;
      }

      const run = this.currentJsonRun;
      if (!run || (message.runId && message.runId !== run.runId)) {
        return;
      }

      if (message.type === 'progress') {
        this.handleWorkerProgress({
          taskId: run.taskId,
          sessionId: run.sessionId,
          workerMode: 'child-json-worker',
          workerPid: child.pid || undefined,
          phase: String(message.phase || ''),
          text: typeof message.text === 'string' ? message.text : '',
        });
        return;
      }

      if (message.type === 'result') {
        this.finishJsonRun(() => {
          const result = {
            response: String(message.response || ''),
            usage: message.usage,
            finishReason: message.finishReason ?? null,
          };
          this.appendRuntimeFinalRecord({
            sessionId: run.sessionId,
            response: result.response,
            usage: result.usage,
            finishReason: result.finishReason,
          });
          run.resolve(result);
        });
        return;
      }

      if (message.type === 'error') {
        this.finishJsonRun(() => {
          const messageText = String(message.error || 'Worker execution failed');
          this.appendRuntimeFailureRecord(run.sessionId, messageText);
          run.reject(new Error(messageText));
        });
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text && this.currentJsonRun) {
        void getBackgroundTaskRegistry().appendTurn(this.currentJsonRun.taskId, {
          source: 'system',
          text: `[worker-stderr] ${text}`,
        });
      }
    });

    const handleExit = (reason: string) => {
      this.jsonWorker = null;
      this.jsonWorkerReady = false;
      const run = this.currentJsonRun;
      if (run) {
        this.finishJsonRun(() => run.reject(new Error(reason)));
      }
    };

    child.on('error', (error) => {
      handleExit(error instanceof Error ? error.message : String(error));
    });

    child.on('exit', (code, signal) => {
      handleExit(`JSON worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    await new Promise<void>((resolve) => {
      this.jsonReadyResolvers.push(resolve);
    });

    return child;
  }

  private async ensureRuntimeWorker(): Promise<ChildProcess> {
    if (this.runtimeWorker && !this.runtimeWorker.killed && this.runtimeWorkerReady) {
      return this.runtimeWorker;
    }

    const child = createWorker('child-runtime-worker', 'query-runtime-worker.mjs');
    this.runtimeWorker = child;
    this.runtimeWorkerReady = false;

    child.on('message', (message: any) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ready') {
        this.runtimeWorkerReady = true;
        for (const resolve of this.runtimeReadyResolvers.splice(0)) {
          resolve();
        }
        return;
      }

      if (message.type === 'heartbeat') {
        const run = this.currentRuntimeRun;
        if (run && (!message.runId || message.runId === run.runId)) {
          void getBackgroundTaskRegistry().updateWorkerProcess(run.taskId, {
            workerMode: 'child-runtime-worker',
            workerPid: child.pid || undefined,
            heartbeatAt: new Date().toISOString(),
          });
        }
        return;
      }

      const run = this.currentRuntimeRun;
      if (!run || (message.runId && message.runId !== run.runId)) {
        return;
      }

      if (message.type === 'progress') {
        this.handleWorkerProgress({
          taskId: run.taskId,
          sessionId: run.sessionId,
          workerMode: 'child-runtime-worker',
          workerPid: child.pid || undefined,
          phase: String(message.phase || ''),
          text: typeof message.text === 'string' ? message.text : '',
        });
        return;
      }

      if (message.type === 'tool-call-batch') {
        void this.handleRuntimeToolBatch(child, run, Array.isArray(message.calls) ? message.calls : []);
        return;
      }

      if (message.type === 'result') {
        this.finishRuntimeRun(() => {
          const result = {
            response: String(message.response || ''),
            usage: message.usage,
            finishReason: message.finishReason ?? null,
          };
          this.appendRuntimeFinalRecord({
            sessionId: run.sessionId,
            response: result.response,
            usage: result.usage,
            finishReason: result.finishReason,
          });
          run.resolve(result);
        });
        return;
      }

      if (message.type === 'error') {
        this.finishRuntimeRun(() => {
          const messageText = String(message.error || 'Runtime worker execution failed');
          this.appendRuntimeFailureRecord(run.sessionId, messageText);
          run.reject(new Error(messageText));
        });
      }
    });

    child.stderr?.on('data', (chunk) => {
      const text = String(chunk || '').trim();
      if (text && this.currentRuntimeRun) {
        void getBackgroundTaskRegistry().appendTurn(this.currentRuntimeRun.taskId, {
          source: 'system',
          text: `[runtime-worker-stderr] ${text}`,
        });
      }
    });

    const handleExit = (reason: string) => {
      this.runtimeWorker = null;
      this.runtimeWorkerReady = false;
      const run = this.currentRuntimeRun;
      if (run) {
        run.toolAbortController.abort();
        this.finishRuntimeRun(() => run.reject(new Error(reason)));
      }
    };

    child.on('error', (error) => {
      handleExit(error instanceof Error ? error.message : String(error));
    });

    child.on('exit', (code, signal) => {
      handleExit(`Runtime worker exited unexpectedly (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    });

    await new Promise<void>((resolve) => {
      this.runtimeReadyResolvers.push(resolve);
    });

    return child;
  }

  private handleWorkerProgress(input: {
    taskId: string;
    sessionId: string;
    workerMode: WorkerMode;
    workerPid?: number;
    phase: string;
    text: string;
  }): void {
    const registry = getBackgroundTaskRegistry();
    const normalizedPhase = String(input.phase || '').trim();
    if (normalizedPhase === 'starting') {
      void registry.updatePhase(input.taskId, 'starting');
    } else if (normalizedPhase === 'thinking') {
      void registry.updatePhase(input.taskId, 'thinking');
    } else if (normalizedPhase === 'tooling') {
      void registry.updatePhase(input.taskId, 'tooling');
    } else if (normalizedPhase === 'responding') {
      void registry.updatePhase(input.taskId, 'responding');
    }
    void registry.updateWorkerProcess(input.taskId, {
      workerMode: input.workerMode,
      workerPid: input.workerPid,
      heartbeatAt: new Date().toISOString(),
    });
    if (input.text) {
      void registry.appendTurn(input.taskId, {
        source: normalizedPhase === 'responding' ? 'response' : normalizedPhase === 'tooling' ? 'tool' : 'system',
        text: input.text,
      });
      this.runtimeStore.appendTranscript({
        sessionId: input.sessionId,
        recordType: 'worker.progress',
        role: normalizedPhase === 'responding' ? 'assistant' : 'system',
        content: input.text,
        payload: {
          kind: 'worker.progress',
          data: {
            phase: normalizedPhase,
            workerMode: input.workerMode,
            workerPid: input.workerPid,
          },
        },
      });
    }
  }

  private appendRuntimeStartRecord(params: {
    sessionId: string;
    toolPack: string;
    workerMode: WorkerMode;
    workerPid?: number;
    userInput: string;
  }): void {
    this.runtimeStore.appendTranscript({
      sessionId: params.sessionId,
      recordType: 'query.user',
      role: 'user',
      content: params.userInput,
      payload: {
        kind: 'query.user',
        data: {
          toolPack: params.toolPack,
          workerMode: params.workerMode,
          workerPid: params.workerPid,
        },
      },
    });
    this.runtimeStore.addCheckpoint({
      sessionId: params.sessionId,
      checkpointType: 'query.start',
      summary: '后台任务已进入统一运行时',
      payload: {
        toolPack: params.toolPack,
        workerMode: params.workerMode,
        workerPid: params.workerPid,
      },
    });
  }

  private appendRuntimeFinalRecord(params: {
    sessionId: string;
    response: string;
    finishReason?: string | null;
    usage?: unknown;
  }): void {
    this.runtimeStore.appendTranscript({
      sessionId: params.sessionId,
      recordType: 'assistant.response',
      role: 'assistant',
      content: params.response,
      payload: {
        kind: 'assistant.response',
        data: {
          finishReason: params.finishReason ?? null,
          usage: params.usage ?? null,
        },
      },
    });
    this.runtimeStore.addCheckpoint({
      sessionId: params.sessionId,
      checkpointType: 'response.final',
      summary: params.response.slice(0, 240) || '后台 assistant response completed',
      payload: {
        responseLength: params.response.length,
        finishReason: params.finishReason ?? null,
        usage: params.usage ?? null,
      },
    });
  }

  private appendRuntimeFailureRecord(sessionId: string, message: string): void {
    this.runtimeStore.appendTranscript({
      sessionId,
      recordType: 'runtime.error',
      role: 'system',
      content: message,
      payload: {
        kind: 'runtime.error',
        data: {},
      },
    });
    this.runtimeStore.addCheckpoint({
      sessionId,
      checkpointType: 'stop.failure',
      summary: message,
      payload: {},
    });
  }

  private finishJsonRun(fn: () => void): void {
    const run = this.currentJsonRun;
    if (!run) return;
    if (run.attemptSignal) {
      run.attemptSignal.removeEventListener('abort', this.abortJsonRun);
    }
    getBackgroundTaskRegistry().clearCancelHandle(run.taskId);
    this.currentJsonRun = null;
    fn();
    const next = this.jsonQueue.shift();
    if (next) next();
  }

  private finishRuntimeRun(fn: () => void): void {
    const run = this.currentRuntimeRun;
    if (!run) return;
    if (run.attemptSignal) {
      run.attemptSignal.removeEventListener('abort', this.abortRuntimeRun);
    }
    run.toolAbortController.abort();
    getBackgroundTaskRegistry().clearCancelHandle(run.taskId);
    this.currentRuntimeRun = null;
    fn();
    const next = this.runtimeQueue.shift();
    if (next) next();
  }

  private abortJsonRun = () => {
    if (!this.jsonWorker || !this.currentJsonRun) return;
    this.jsonWorker.send?.({ type: 'abort', runId: this.currentJsonRun.runId });
  };

  private abortRuntimeRun = () => {
    if (!this.runtimeWorker || !this.currentRuntimeRun) return;
    this.currentRuntimeRun.toolAbortController.abort();
    this.runtimeWorker.send?.({ type: 'abort', runId: this.currentRuntimeRun.runId });
  };

  async runJsonTask(input: {
    taskId: string;
    sessionId: string;
    model: string;
    apiKey: string;
    baseURL: string;
    systemPrompt: string;
    userInput: string;
    temperature?: number;
    rollback?: () => Promise<void> | void;
    attemptSignal?: AbortSignal;
  }): Promise<JsonWorkerResult> {
    return await new Promise<JsonWorkerResult>((resolve, reject) => {
      const run = async () => {
        try {
          const child = await this.ensureJsonWorker();
          const runId = nextId('json_run');
          const registry = getBackgroundTaskRegistry();
          this.currentJsonRun = {
            runId,
            taskId: input.taskId,
            sessionId: input.sessionId,
            rollback: input.rollback,
            attemptSignal: input.attemptSignal,
            resolve,
            reject,
          };

          registry.registerCancelHandle(input.taskId, {
            cancel: () => {
              child.send?.({ type: 'abort', runId });
            },
            rollback: input.rollback,
          });

          await registry.updateWorkerProcess(input.taskId, {
            workerMode: 'child-json-worker',
            workerPid: child.pid || undefined,
            heartbeatAt: new Date().toISOString(),
          });
          await registry.appendTurn(input.taskId, {
            source: 'system',
            text: `[worker] connected to persistent JSON child pid=${child.pid || 'unknown'}`,
          });
          this.appendRuntimeStartRecord({
            sessionId: input.sessionId,
            toolPack: 'background-maintenance',
            workerMode: 'child-json-worker',
            workerPid: child.pid || undefined,
            userInput: input.userInput,
          });

          if (input.attemptSignal) {
            if (input.attemptSignal.aborted) {
              this.abortJsonRun();
            } else {
              input.attemptSignal.addEventListener('abort', this.abortJsonRun, { once: true });
            }
          }

          child.send?.({
            type: 'run-json-task',
            runId,
            payload: {
              model: input.model,
              apiKey: input.apiKey,
              baseURL: input.baseURL,
              systemPrompt: input.systemPrompt,
              userInput: input.userInput,
              temperature: input.temperature ?? 0.1,
            },
          });
        } catch (error) {
          reject(error);
        }
      };

      if (this.currentJsonRun) {
        this.jsonQueue.push(run);
        return;
      }
      void run();
    });
  }

  async runRuntimeTask(input: {
    taskId: string;
    sessionId: string;
    model: string;
    apiKey: string;
    baseURL: string;
    systemPrompt: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    userInput: string;
    toolPack: BuiltinToolPack;
    runtimeMode?: string;
    requiresHumanApproval?: boolean;
    temperature?: number;
    maxTurns?: number;
    maxTimeMinutes?: number;
    rollback?: () => Promise<void> | void;
    attemptSignal?: AbortSignal;
  }): Promise<RuntimeWorkerResult> {
    return await new Promise<RuntimeWorkerResult>((resolve, reject) => {
      const run = async () => {
        try {
          const child = await this.ensureRuntimeWorker();
          const runId = nextId('runtime_run');
          const registry = getBackgroundTaskRegistry();
          const toolRegistry = new ToolRegistry();
          toolRegistry.registerTools(createBuiltinTools({ pack: input.toolPack }));

          this.currentRuntimeRun = {
            runId,
            taskId: input.taskId,
            sessionId: input.sessionId,
            toolPack: input.toolPack,
            runtimeMode: input.runtimeMode,
            requiresHumanApproval: input.requiresHumanApproval,
            rollback: input.rollback,
            attemptSignal: input.attemptSignal,
            toolAbortController: new AbortController(),
            resolve,
            reject,
          };

          registry.registerCancelHandle(input.taskId, {
            cancel: () => {
              this.abortRuntimeRun();
            },
            rollback: input.rollback,
          });

          await registry.updateWorkerProcess(input.taskId, {
            workerMode: 'child-runtime-worker',
            workerPid: child.pid || undefined,
            heartbeatAt: new Date().toISOString(),
          });
          await registry.appendTurn(input.taskId, {
            source: 'system',
            text: `[worker] connected to persistent runtime child pid=${child.pid || 'unknown'} pack=${input.toolPack}`,
          });
          this.appendRuntimeStartRecord({
            sessionId: input.sessionId,
            toolPack: input.toolPack,
            workerMode: 'child-runtime-worker',
            workerPid: child.pid || undefined,
            userInput: input.userInput,
          });

          if (input.attemptSignal) {
            if (input.attemptSignal.aborted) {
              this.abortRuntimeRun();
            } else {
              input.attemptSignal.addEventListener('abort', this.abortRuntimeRun, { once: true });
            }
          }

          child.send?.({
            type: 'run-query-task',
            runId,
            payload: {
              model: input.model,
              apiKey: input.apiKey,
              baseURL: input.baseURL,
              systemPrompt: input.systemPrompt,
              messages: input.messages,
              userInput: input.userInput,
              temperature: input.temperature ?? 0.6,
              maxTurns: input.maxTurns ?? 24,
              maxTimeMinutes: input.maxTimeMinutes ?? 12,
              toolSchemas: toolRegistry.getToolSchemas(),
            },
          });
        } catch (error) {
          reject(error);
        }
      };

      if (this.currentRuntimeRun) {
        this.runtimeQueue.push(run);
        return;
      }
      void run();
    });
  }

  private async handleRuntimeToolBatch(
    child: ChildProcess,
    run: PendingRuntimeRun,
    calls: ToolCallMessage[],
  ): Promise<void> {
    try {
      const results = await this.executeHostedToolBatch(run, calls);
      child.send?.({
        type: 'tool-result-batch',
        runId: run.runId,
        results,
      });
    } catch (error) {
      child.send?.({
        type: 'tool-result-batch',
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async executeHostedToolBatch(run: PendingRuntimeRun, calls: ToolCallMessage[]): Promise<HostedToolFeedback[]> {
    const registry = new ToolRegistry();
    registry.registerTools(createBuiltinTools({ pack: run.toolPack }));
    const executor = new ToolExecutor(registry, async () => ToolConfirmationOutcome.ProceedOnce);

    this.runtimeStore.appendTranscript({
      sessionId: run.sessionId,
      recordType: 'assistant.tool_call',
      role: 'assistant',
      content: '',
      payload: {
        kind: 'assistant.tool_call',
        data: {
          calls: calls.map((call) => ({ id: call.id, name: call.name, args: call.args })),
          workerMode: 'child-runtime-worker',
        },
      },
    });

    const responses: ToolCallResponse[] = [];
    for (const call of calls) {
      await getBackgroundTaskRegistry().appendTurn(run.taskId, {
        source: 'tool',
        text: `调用工具：${call.name}`,
      });
      const tool = registry.getTool(call.name);
      if (!tool) {
        const missingResult = createErrorResult(`Tool "${call.name}" not found`, ToolErrorType.EXECUTION_FAILED);
        responses.push({
          callId: call.id,
          name: call.name,
          result: missingResult,
          durationMs: 0,
        });
        await getBackgroundTaskRegistry().appendTurn(run.taskId, {
          source: 'system',
          text: `${call.name}: error | tool not found`,
        });
        continue;
      }
      const permission = evaluateRuntimeToolPermission({
        tool,
        toolName: call.name,
        args: call.args,
        context: {
          sessionId: run.sessionId,
          toolPack: run.toolPack,
          runtimeMode: run.runtimeMode,
          interactive: false,
          requiresHumanApproval: run.requiresHumanApproval,
        },
      });
      if (permission.outcome === 'deny') {
        this.runtimeStore.appendTranscript({
          sessionId: run.sessionId,
          recordType: 'tool.permission',
          role: 'system',
          content: `${call.name}: deny - ${permission.reason}`,
          payload: {
            kind: 'tool.permission',
            data: {
              callId: call.id,
              toolName: call.name,
              outcome: 'deny',
              workerMode: 'child-runtime-worker',
            },
          },
        });
        this.runtimeStore.addCheckpoint({
          sessionId: run.sessionId,
          checkpointType: 'tool.permission.denied',
          summary: `${call.name}: ${permission.reason}`,
          payload: {
            callId: call.id,
            toolName: call.name,
            workerMode: 'child-runtime-worker',
          },
        });
        const deniedResult = createErrorResult(permission.reason, ToolErrorType.PERMISSION_DENIED);
        const deniedResponse: ToolCallResponse = {
          callId: call.id,
          name: call.name,
          result: deniedResult,
          durationMs: 0,
        };
        responses.push(deniedResponse);
        await getBackgroundTaskRegistry().appendTurn(run.taskId, {
          source: 'system',
          text: `${call.name}: permission denied | ${permission.reason}`,
        });
      } else {
        if (permission.outcome === 'confirm') {
          this.runtimeStore.appendTranscript({
            sessionId: run.sessionId,
            recordType: 'tool.permission',
            role: 'system',
            content: `${call.name}: confirm - ${permission.reason}`,
            payload: {
              kind: 'tool.permission',
              data: {
                callId: call.id,
                toolName: call.name,
                outcome: 'confirm',
                workerMode: 'child-runtime-worker',
              },
            },
          });
          await getBackgroundTaskRegistry().appendTurn(run.taskId, {
            source: 'system',
            text: `${call.name}: auto-approved in hosted worker | ${permission.reason}`,
          });
        }
        const response = await executor.execute({
          callId: call.id,
          name: call.name,
          params: call.args,
          forceConfirmation: permission.outcome === 'confirm',
          confirmationDetails: permission.details || null,
        } satisfies ToolCallRequest, run.toolAbortController.signal);
        responses.push(response);
      }
      const response = responses[responses.length - 1];
      const resultText = String(response.result.llmContent || response.result.display || response.result.error?.message || '').trim();
      const summaryText = resultText.length > 4_000
        ? `${resultText.slice(0, 4_000)}\n\n[tool result summarized for runtime event]`
        : resultText;
      const persisted = this.toolResultStore.add({
        sessionId: run.sessionId,
        callId: response.callId,
        toolName: response.name,
        command: typeof call.args.command === 'string' ? call.args.command : undefined,
        result: response.result,
        summaryText,
        payload: {
          durationMs: response.durationMs,
          workerMode: 'child-runtime-worker',
        },
      });
      this.runtimeStore.appendTranscript({
        sessionId: run.sessionId,
        recordType: 'tool.result',
        role: 'tool',
        content: summaryText || response.result.llmContent,
        payload: {
          kind: 'tool.result',
          data: {
            toolResultId: persisted.id,
            callId: response.callId,
            toolName: response.name,
            success: response.result.success,
            durationMs: response.durationMs,
          },
        },
      });
      await getBackgroundTaskRegistry().appendTurn(run.taskId, {
        source: 'tool',
        text: `${call.name}: ${response.result.success ? 'success' : 'error'}${response.result.error?.message ? ` | ${response.result.error.message}` : ''}`,
      });
    }

    const budgeted = applyToolResultBudget(
      registry,
      responses.map((response) => ({
        toolName: response.name,
        result: response.result,
      })),
    );

    const feedback = budgeted.map((item, index) => {
      const response = responses[index];
      const persisted = response
        ? this.toolResultStore.applyBudget({
            sessionId: run.sessionId,
            callId: response.callId,
            promptText: item.promptText,
            originalChars: item.originalChars,
            promptChars: item.promptChars,
            truncated: item.truncated,
          })
        : null;
      if (item.truncated) {
        this.runtimeStore.appendTranscript({
          sessionId: run.sessionId,
          recordType: 'tool.result.budget',
          role: 'system',
          content: `tool=${item.toolName}; original=${item.originalChars}; prompt=${item.promptChars}`,
          payload: {
            kind: 'tool.result.budget',
            data: {
              toolName: item.toolName,
              callId: response?.callId,
              toolResultId: persisted?.id,
              originalChars: item.originalChars,
              promptChars: item.promptChars,
            },
          },
        });
      }
      return {
        toolName: item.toolName,
        promptText: item.promptText,
        success: response?.result.success ?? true,
      };
    });

    this.runtimeStore.addCheckpoint({
      sessionId: run.sessionId,
      checkpointType: 'tool.batch',
      summary: `Completed ${responses.length} hosted tool call(s)`,
      payload: {
        tools: responses.map((response) => ({
          callId: response.callId,
          name: response.name,
          success: response.result.success,
        })),
      },
    });

    return feedback;
  }

  async dispose(): Promise<void> {
    this.jsonQueue = [];
    this.runtimeQueue = [];

    if (this.currentJsonRun && this.jsonWorker) {
      this.jsonWorker.send?.({ type: 'abort', runId: this.currentJsonRun.runId });
    }
    if (this.currentRuntimeRun && this.runtimeWorker) {
      this.currentRuntimeRun.toolAbortController.abort();
      this.runtimeWorker.send?.({ type: 'abort', runId: this.currentRuntimeRun.runId });
    }

    if (this.jsonWorker && !this.jsonWorker.killed) {
      this.jsonWorker.kill();
    }
    if (this.runtimeWorker && !this.runtimeWorker.killed) {
      this.runtimeWorker.kill();
    }

    this.jsonWorker = null;
    this.jsonWorkerReady = false;
    this.currentJsonRun = null;
    this.runtimeWorker = null;
    this.runtimeWorkerReady = false;
    this.currentRuntimeRun = null;
  }
}

let headlessWorkerProcessManager: HeadlessWorkerProcessManager | null = null;

export function getHeadlessWorkerProcessManager(): HeadlessWorkerProcessManager {
  if (!headlessWorkerProcessManager) {
    headlessWorkerProcessManager = new HeadlessWorkerProcessManager();
  }
  return headlessWorkerProcessManager;
}
