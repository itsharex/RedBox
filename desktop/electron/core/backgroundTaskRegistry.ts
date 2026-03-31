import { EventEmitter } from 'events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getWorkspacePaths } from '../db';

export type BackgroundTaskKind =
  | 'redclaw-project'
  | 'scheduled-task'
  | 'long-cycle'
  | 'heartbeat'
  | 'memory-maintenance'
  | 'headless-runtime';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundTaskProgressTurn {
  id: string;
  at: string;
  text: string;
  source: 'thought' | 'tool' | 'response' | 'system';
}

export interface BackgroundTaskRecord {
  id: string;
  kind: BackgroundTaskKind;
  title: string;
  status: BackgroundTaskStatus;
  sessionId?: string;
  contextId?: string;
  error?: string;
  summary?: string;
  latestText?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  turns: BackgroundTaskProgressTurn[];
}

type PersistedPayload = {
  tasks: BackgroundTaskRecord[];
};

const MAX_TURNS_PER_TASK = 80;
const MAX_TASKS = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class BackgroundTaskRegistry extends EventEmitter {
  private loadedPath: string | null = null;
  private tasks = new Map<string, BackgroundTaskRecord>();

  private getStorePath(): string {
    return path.join(getWorkspacePaths().redclaw, 'background-tasks.json');
  }

  private async ensureLoaded(): Promise<void> {
    const nextPath = this.getStorePath();
    if (this.loadedPath === nextPath) {
      return;
    }

    this.loadedPath = nextPath;
    this.tasks.clear();
    try {
      const raw = await fs.readFile(nextPath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedPayload;
      for (const item of Array.isArray(parsed.tasks) ? parsed.tasks : []) {
        if (!item?.id) continue;
        this.tasks.set(item.id, item);
      }
    } catch {
      // ignore
    }
  }

  private async persist(): Promise<void> {
    if (!this.loadedPath) {
      this.loadedPath = this.getStorePath();
    }
    const payload: PersistedPayload = {
      tasks: Array.from(this.tasks.values())
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, MAX_TASKS),
    };
    await fs.mkdir(path.dirname(this.loadedPath), { recursive: true });
    await fs.writeFile(this.loadedPath, JSON.stringify(payload, null, 2), 'utf-8');
  }

  private emitUpdate(task: BackgroundTaskRecord): void {
    this.emit('task-updated', task);
  }

  async listTasks(): Promise<BackgroundTaskRecord[]> {
    await this.ensureLoaded();
    return Array.from(this.tasks.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  }

  async getTask(taskId: string): Promise<BackgroundTaskRecord | null> {
    await this.ensureLoaded();
    return this.tasks.get(taskId) || null;
  }

  async registerTask(input: {
    id?: string;
    kind: BackgroundTaskKind;
    title: string;
    contextId?: string;
    sessionId?: string;
  }): Promise<BackgroundTaskRecord> {
    await this.ensureLoaded();
    const now = nowIso();
    const task: BackgroundTaskRecord = {
      id: input.id || nextId('bg_task'),
      kind: input.kind,
      title: input.title,
      status: 'running',
      contextId: input.contextId,
      sessionId: input.sessionId,
      createdAt: now,
      updatedAt: now,
      turns: [],
    };
    this.tasks.set(task.id, task);
    await this.persist();
    this.emitUpdate(task);
    return task;
  }

  async attachSession(taskId: string, sessionId: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.sessionId = sessionId;
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async appendTurn(taskId: string, turn: Omit<BackgroundTaskProgressTurn, 'id' | 'at'>): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    const text = String(turn.text || '').trim();
    if (!text) return;
    task.turns.push({
      id: nextId('turn'),
      at: nowIso(),
      text,
      source: turn.source,
    });
    task.turns = task.turns.slice(-MAX_TURNS_PER_TASK);
    task.latestText = text;
    task.updatedAt = nowIso();
    await this.persist();
    this.emitUpdate(task);
  }

  async completeTask(taskId: string, summary?: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    const now = nowIso();
    task.status = 'completed';
    task.summary = summary || task.summary;
    task.updatedAt = now;
    task.completedAt = now;
    await this.persist();
    this.emitUpdate(task);
  }

  async failTask(taskId: string, error: string): Promise<void> {
    await this.ensureLoaded();
    const task = this.tasks.get(taskId);
    if (!task) return;
    const now = nowIso();
    task.status = 'failed';
    task.error = error;
    task.updatedAt = now;
    task.completedAt = now;
    await this.persist();
    this.emitUpdate(task);
  }
}

let backgroundTaskRegistry: BackgroundTaskRegistry | null = null;

export function getBackgroundTaskRegistry(): BackgroundTaskRegistry {
  if (!backgroundTaskRegistry) {
    backgroundTaskRegistry = new BackgroundTaskRegistry();
  }
  return backgroundTaskRegistry;
}
