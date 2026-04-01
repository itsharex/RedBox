import { EventEmitter } from 'events';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { getWorkspacePaths } from '../db';
import { getBackgroundTaskRegistry } from './backgroundTaskRegistry';
import { getHeadlessAgentRunner } from './headlessAgentRunner';
import {
  releaseBackgroundRuntimeLock,
  tryAcquireBackgroundRuntimeLock,
} from './backgroundRuntimeLock';

type AssistantChannelProvider = 'feishu' | 'weixin' | 'relay';
type DaemonLockState = 'owner' | 'passive';

type AssistantDaemonIngressMessage = {
  provider: AssistantChannelProvider;
  accountId?: string;
  peerId: string;
  userId?: string;
  userName?: string;
  messageId?: string;
  text: string;
  waitForReply?: boolean;
  metadata?: Record<string, unknown>;
};

type AssistantDaemonProcessResult = {
  taskId: string;
  sessionId: string;
  response: string;
};

type FeishuDaemonConfig = {
  enabled: boolean;
  endpointPath: string;
  verificationToken?: string;
  appId?: string;
  appSecret?: string;
  replyUsingChatId: boolean;
};

type RelayDaemonConfig = {
  enabled: boolean;
  endpointPath: string;
  authToken?: string;
};

type WeixinDaemonConfig = {
  enabled: boolean;
  endpointPath: string;
  authToken?: string;
  autoStartSidecar: boolean;
  sidecarCommand?: string;
  sidecarArgs?: string[];
  sidecarCwd?: string;
  sidecarEnv?: Record<string, string>;
};

type AssistantDaemonConfig = {
  enabled: boolean;
  autoStart: boolean;
  keepAliveWhenNoWindow: boolean;
  host: string;
  port: number;
  feishu: FeishuDaemonConfig;
  relay: RelayDaemonConfig;
  weixin: WeixinDaemonConfig;
};

export type AssistantDaemonStatus = {
  enabled: boolean;
  autoStart: boolean;
  keepAliveWhenNoWindow: boolean;
  host: string;
  port: number;
  listening: boolean;
  lockState: DaemonLockState;
  blockedBy: string | null;
  lastError: string | null;
  activeTaskCount: number;
  queuedPeerCount: number;
  inFlightKeys: string[];
  feishu: FeishuDaemonConfig & { webhookUrl: string };
  relay: RelayDaemonConfig & { webhookUrl: string };
  weixin: WeixinDaemonConfig & { webhookUrl: string; sidecarRunning: boolean; sidecarPid?: number };
};

const DEFAULT_CONFIG: AssistantDaemonConfig = {
  enabled: false,
  autoStart: true,
  keepAliveWhenNoWindow: true,
  host: '127.0.0.1',
  port: 31937,
  feishu: {
    enabled: false,
    endpointPath: '/hooks/feishu/events',
    replyUsingChatId: true,
  },
  relay: {
    enabled: true,
    endpointPath: '/hooks/channel/relay',
  },
  weixin: {
    enabled: false,
    endpointPath: '/hooks/weixin/relay',
    autoStartSidecar: false,
  },
};

const LOCK_PROBE_INTERVAL_MS = 5_000;
const MESSAGE_DEDUPE_TTL_MS = 15 * 60 * 1000;
const MAX_RECENT_MESSAGE_IDS = 2000;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizePort(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIG.port;
  return Math.max(1024, Math.min(65535, Math.round(parsed)));
}

function sanitizeHost(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return DEFAULT_CONFIG.host;
  return text;
}

function sanitizeEndpointPath(value: unknown, fallback: string): string {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.startsWith('/') ? text : `/${text}`;
}

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function sanitizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const next: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    next[normalizedKey] = String(raw ?? '');
  }
  return next;
}

function normalizeConfig(input?: Partial<AssistantDaemonConfig> | null): AssistantDaemonConfig {
  const feishuInput = input?.feishu || {};
  const relayInput = input?.relay || {};
  const weixinInput = input?.weixin || {};
  return {
    enabled: Boolean(input?.enabled),
    autoStart: input?.autoStart === undefined ? DEFAULT_CONFIG.autoStart : Boolean(input.autoStart),
    keepAliveWhenNoWindow: input?.keepAliveWhenNoWindow === undefined
      ? DEFAULT_CONFIG.keepAliveWhenNoWindow
      : Boolean(input.keepAliveWhenNoWindow),
    host: sanitizeHost(input?.host),
    port: sanitizePort(input?.port),
    feishu: {
      enabled: Boolean(feishuInput.enabled),
      endpointPath: sanitizeEndpointPath(feishuInput.endpointPath, DEFAULT_CONFIG.feishu.endpointPath),
      verificationToken: String(feishuInput.verificationToken || '').trim() || undefined,
      appId: String(feishuInput.appId || '').trim() || undefined,
      appSecret: String(feishuInput.appSecret || '').trim() || undefined,
      replyUsingChatId: feishuInput.replyUsingChatId === undefined
        ? DEFAULT_CONFIG.feishu.replyUsingChatId
        : Boolean(feishuInput.replyUsingChatId),
    },
    relay: {
      enabled: relayInput.enabled === undefined ? DEFAULT_CONFIG.relay.enabled : Boolean(relayInput.enabled),
      endpointPath: sanitizeEndpointPath(relayInput.endpointPath, DEFAULT_CONFIG.relay.endpointPath),
      authToken: String(relayInput.authToken || '').trim() || undefined,
    },
    weixin: {
      enabled: Boolean(weixinInput.enabled),
      endpointPath: sanitizeEndpointPath(weixinInput.endpointPath, DEFAULT_CONFIG.weixin.endpointPath),
      authToken: String(weixinInput.authToken || '').trim() || undefined,
      autoStartSidecar: Boolean(weixinInput.autoStartSidecar),
      sidecarCommand: String(weixinInput.sidecarCommand || '').trim() || undefined,
      sidecarArgs: sanitizeStringArray(weixinInput.sidecarArgs),
      sidecarCwd: String(weixinInput.sidecarCwd || '').trim() || undefined,
      sidecarEnv: sanitizeStringRecord(weixinInput.sidecarEnv),
    },
  };
}

function mergeConfig(base: AssistantDaemonConfig, patch?: Partial<AssistantDaemonConfig> | null): AssistantDaemonConfig {
  if (!patch) {
    return normalizeConfig(base);
  }
  return normalizeConfig({
    ...base,
    ...patch,
    feishu: {
      ...base.feishu,
      ...(patch.feishu || {}),
    },
    relay: {
      ...base.relay,
      ...(patch.relay || {}),
    },
    weixin: {
      ...base.weixin,
      ...(patch.weixin || {}),
    },
  });
}

function createWebhookUrl(host: string, port: number, endpointPath: string): string {
  return `http://${host}:${port}${endpointPath}`;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || 'unknown error');
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += next.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(next);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function parseFeishuTextContent(content: unknown): string {
  const raw = String(content || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return String(parsed?.text || '').trim();
  } catch {
    return raw;
  }
}

function buildRelayPrompt(message: AssistantDaemonIngressMessage): string {
  const lines = [
    '你现在是 RedConvert 的长期在线后台助理，正在通过外部消息渠道接收用户指令。',
    `渠道: ${message.provider}`,
    `会话键: ${message.accountId ? `${message.accountId}:` : ''}${message.peerId}`,
  ];
  if (message.userName || message.userId) {
    lines.push(`发送者: ${message.userName || message.userId}`);
  }
  lines.push('输出要求:');
  lines.push('- 直接回答用户，不要暴露系统实现。');
  lines.push('- 默认输出适合聊天软件发送的纯文本。');
  lines.push('- 除非用户要求，不要输出 Markdown 表格。');
  lines.push('用户消息:');
  lines.push(message.text);
  return lines.join('\n');
}

export class AssistantDaemonService extends EventEmitter {
  private config: AssistantDaemonConfig = { ...DEFAULT_CONFIG };
  private isLoaded = false;
  private readonly lockOwnerId = `assistant-daemon:${process.pid}:${Date.now().toString(36)}`;
  private lockState: DaemonLockState = 'passive';
  private blockedBy: string | null = null;
  private server: http.Server | null = null;
  private listening = false;
  private lastError: string | null = null;
  private lockProbeTimer: NodeJS.Timeout | null = null;
  private readonly peerQueues = new Map<string, Promise<AssistantDaemonProcessResult>>();
  private readonly inFlightKeys = new Set<string>();
  private readonly recentMessageIds = new Map<string, number>();
  private feishuTokenCache: { token: string; expiresAtMs: number } | null = null;
  private weixinSidecar: ChildProcessWithoutNullStreams | null = null;

  private getConfigPath(): string {
    return path.join(getWorkspacePaths().redclaw, 'assistant-daemon.json');
  }

  private getLockPath(): string {
    return path.join(getWorkspacePaths().redclaw, 'assistant-daemon.lock');
  }

  async init(): Promise<void> {
    await this.ensureLoaded();
    if (this.config.enabled && this.config.autoStart) {
      await this.startServerIfNeeded();
    }
    this.emitStatus();
  }

  async reloadForWorkspaceChange(): Promise<void> {
    await this.stopServerInternals();
    this.isLoaded = false;
    this.lockState = 'passive';
    this.blockedBy = null;
    this.lastError = null;
    this.feishuTokenCache = null;
    await this.init();
  }

  async shouldKeepAliveWhenNoWindow(): Promise<boolean> {
    await this.ensureLoaded();
    return this.config.enabled && this.config.keepAliveWhenNoWindow && this.lockState === 'owner';
  }

  getStatus(): AssistantDaemonStatus {
    return {
      enabled: this.config.enabled,
      autoStart: this.config.autoStart,
      keepAliveWhenNoWindow: this.config.keepAliveWhenNoWindow,
      host: this.config.host,
      port: this.config.port,
      listening: this.listening,
      lockState: this.lockState,
      blockedBy: this.blockedBy,
      lastError: this.lastError,
      activeTaskCount: this.inFlightKeys.size,
      queuedPeerCount: this.peerQueues.size,
      inFlightKeys: Array.from(this.inFlightKeys.values()),
      feishu: {
        ...this.config.feishu,
        webhookUrl: createWebhookUrl(this.config.host, this.config.port, this.config.feishu.endpointPath),
      },
      relay: {
        ...this.config.relay,
        webhookUrl: createWebhookUrl(this.config.host, this.config.port, this.config.relay.endpointPath),
      },
      weixin: {
        ...this.config.weixin,
        webhookUrl: createWebhookUrl(this.config.host, this.config.port, this.config.weixin.endpointPath),
        sidecarRunning: Boolean(this.weixinSidecar && !this.weixinSidecar.killed),
        sidecarPid: this.weixinSidecar?.pid,
      },
    };
  }

  async start(input?: Partial<AssistantDaemonConfig>): Promise<AssistantDaemonStatus> {
    await this.ensureLoaded();
    this.config = mergeConfig(this.config, input);
    this.config.enabled = true;
    await this.persistConfig();
    await this.startServerIfNeeded();
    this.emitStatus();
    return this.getStatus();
  }

  async stop(): Promise<AssistantDaemonStatus> {
    await this.ensureLoaded();
    this.config.enabled = false;
    await this.persistConfig();
    await this.stopServerInternals();
    this.emitStatus();
    return this.getStatus();
  }

  async setConfig(input?: Partial<AssistantDaemonConfig>): Promise<AssistantDaemonStatus> {
    await this.ensureLoaded();
    const previousListeningAddress = `${this.config.host}:${this.config.port}`;
    this.config = mergeConfig(this.config, input);
    await this.persistConfig();
    const nextListeningAddress = `${this.config.host}:${this.config.port}`;
    if (!this.config.enabled) {
      await this.stopServerInternals();
    } else if (this.listening && previousListeningAddress !== nextListeningAddress) {
      await this.stopServerInternals({ preserveEnabledState: true });
      await this.startServerIfNeeded();
    } else if (this.config.enabled && !this.listening) {
      await this.startServerIfNeeded();
    }
    await this.syncWeixinSidecar();
    this.emitStatus();
    return this.getStatus();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.isLoaded) return;
    await this.loadConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = await fs.readFile(this.getConfigPath(), 'utf-8');
      this.config = normalizeConfig(JSON.parse(raw) as Partial<AssistantDaemonConfig>);
    } catch {
      this.config = normalizeConfig(DEFAULT_CONFIG);
      await this.persistConfig();
    }
    this.isLoaded = true;
  }

  private async persistConfig(): Promise<void> {
    const configPath = this.getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  private emitStatus(): void {
    this.emit('status', this.getStatus());
  }

  private emitLog(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void {
    this.emit('log', {
      at: nowIso(),
      level,
      message,
      details: details || {},
    });
  }

  private clearLockProbe(): void {
    if (!this.lockProbeTimer) return;
    clearTimeout(this.lockProbeTimer);
    this.lockProbeTimer = null;
  }

  private scheduleLockProbe(): void {
    this.clearLockProbe();
    if (!this.config.enabled || this.lockState === 'owner') {
      return;
    }
    this.lockProbeTimer = setTimeout(() => {
      void this.tryBecomeOwnerFromPassive();
    }, LOCK_PROBE_INTERVAL_MS);
  }

  private async acquireOwnership(): Promise<boolean> {
    const result = await tryAcquireBackgroundRuntimeLock(this.getLockPath(), this.lockOwnerId);
    if (result.acquired) {
      this.lockState = 'owner';
      this.blockedBy = null;
      this.clearLockProbe();
      return true;
    }
    this.lockState = 'passive';
    this.blockedBy = result.blockedBy || null;
    this.scheduleLockProbe();
    return false;
  }

  private async releaseOwnership(): Promise<void> {
    this.clearLockProbe();
    await releaseBackgroundRuntimeLock(this.getLockPath(), this.lockOwnerId);
    this.lockState = 'passive';
    this.blockedBy = null;
  }

  private async tryBecomeOwnerFromPassive(): Promise<void> {
    if (!this.config.enabled || this.lockState === 'owner') {
      return;
    }
    try {
      const acquired = await this.acquireOwnership();
      if (!acquired) {
        this.emitStatus();
        return;
      }
      this.emitLog('info', 'Assistant daemon acquired ownership after passive wait.');
      await this.startServerIfNeeded();
    } catch (error) {
      this.lastError = extractErrorMessage(error);
      this.emitLog('error', 'Assistant daemon failed to acquire ownership.', {
        error: this.lastError,
      });
    }
    this.emitStatus();
  }

  private cleanupRecentMessageIds(): void {
    const now = Date.now();
    for (const [key, at] of this.recentMessageIds.entries()) {
      if (now - at > MESSAGE_DEDUPE_TTL_MS) {
        this.recentMessageIds.delete(key);
      }
    }
    if (this.recentMessageIds.size <= MAX_RECENT_MESSAGE_IDS) {
      return;
    }
    const entries = Array.from(this.recentMessageIds.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, this.recentMessageIds.size - MAX_RECENT_MESSAGE_IDS);
    for (const [key] of entries) {
      this.recentMessageIds.delete(key);
    }
  }

  private isDuplicateMessage(provider: AssistantChannelProvider, messageId?: string): boolean {
    const normalized = String(messageId || '').trim();
    if (!normalized) return false;
    this.cleanupRecentMessageIds();
    const key = `${provider}:${normalized}`;
    if (this.recentMessageIds.has(key)) {
      return true;
    }
    this.recentMessageIds.set(key, Date.now());
    return false;
  }

  private async startServerIfNeeded(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }
    if (this.server && this.listening) {
      await this.syncWeixinSidecar();
      return;
    }
    const acquired = await this.acquireOwnership();
    if (!acquired) {
      this.emitLog('warn', 'Assistant daemon is passive because another owner is active.', {
        blockedBy: this.blockedBy,
      });
      this.emitStatus();
      return;
    }

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error('Assistant daemon server missing'));
        return;
      }
      server.once('error', reject);
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    this.listening = true;
    this.lastError = null;
    await this.syncWeixinSidecar();
    this.emitLog('info', 'Assistant daemon listening.', {
      host: this.config.host,
      port: this.config.port,
    });
  }

  private async stopServerInternals(options?: { preserveEnabledState?: boolean }): Promise<void> {
    await this.stopWeixinSidecar();
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.listening = false;
    if (!options?.preserveEnabledState) {
      await this.releaseOwnership();
    }
  }

  private async syncWeixinSidecar(): Promise<void> {
    if (!this.config.enabled || !this.listening || this.lockState !== 'owner') {
      await this.stopWeixinSidecar();
      return;
    }
    const shouldRun = this.config.weixin.enabled
      && this.config.weixin.autoStartSidecar
      && Boolean(this.config.weixin.sidecarCommand);
    if (!shouldRun) {
      await this.stopWeixinSidecar();
      return;
    }
    if (this.weixinSidecar && !this.weixinSidecar.killed) {
      return;
    }

    const env = {
      ...process.env,
      REDCONVERT_RELAY_URL: createWebhookUrl(this.config.host, this.config.port, this.config.weixin.endpointPath),
      REDCONVERT_RELAY_TOKEN: this.config.weixin.authToken || this.config.relay.authToken || '',
      ...this.config.weixin.sidecarEnv,
    };
    const child = spawn(this.config.weixin.sidecarCommand as string, this.config.weixin.sidecarArgs || [], {
      cwd: this.config.weixin.sidecarCwd || process.cwd(),
      env,
      stdio: 'pipe',
    });
    this.weixinSidecar = child;
    child.stdout.on('data', (chunk) => {
      this.emitLog('info', '[weixin-sidecar] stdout', { chunk: String(chunk).trim() });
    });
    child.stderr.on('data', (chunk) => {
      this.emitLog('warn', '[weixin-sidecar] stderr', { chunk: String(chunk).trim() });
    });
    child.once('exit', (code, signal) => {
      const wasTracked = this.weixinSidecar === child;
      if (wasTracked) {
        this.weixinSidecar = null;
      }
      this.emitLog(code === 0 ? 'info' : 'warn', '[weixin-sidecar] exited', {
        code,
        signal,
      });
      this.emitStatus();
    });
    this.emitLog('info', 'Started weixin sidecar process.', {
      pid: child.pid,
      command: this.config.weixin.sidecarCommand,
      args: this.config.weixin.sidecarArgs || [],
    });
  }

  private async stopWeixinSidecar(): Promise<void> {
    const child = this.weixinSidecar;
    if (!child) return;
    this.weixinSidecar = null;
    if (child.killed) return;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const method = String(req.method || 'GET').toUpperCase();
      const url = new URL(req.url || '/', `http://${this.config.host}:${this.config.port}`);
      if (method === 'GET' && url.pathname === '/healthz') {
        sendJson(res, 200, {
          ok: true,
          status: this.getStatus(),
        });
        return;
      }

      if (method !== 'POST') {
        sendJson(res, 405, { success: false, error: 'Method not allowed' });
        return;
      }

      if (url.pathname === this.config.feishu.endpointPath && this.config.feishu.enabled) {
        const body = await readJsonBody(req);
        await this.handleFeishuEvent(body, res);
        return;
      }

      if (url.pathname === this.config.relay.endpointPath && this.config.relay.enabled) {
        const body = await readJsonBody(req);
        await this.handleRelayIngress(body, res, 'relay');
        return;
      }

      if (url.pathname === this.config.weixin.endpointPath && this.config.weixin.enabled) {
        const body = await readJsonBody(req);
        await this.handleRelayIngress(body, res, 'weixin');
        return;
      }

      sendJson(res, 404, { success: false, error: 'Not found' });
    } catch (error) {
      this.lastError = extractErrorMessage(error);
      this.emitLog('error', 'Assistant daemon request failed.', {
        error: this.lastError,
      });
      sendJson(res, 500, { success: false, error: this.lastError });
    } finally {
      this.emitStatus();
    }
  }

  private async handleFeishuEvent(body: Record<string, unknown>, res: http.ServerResponse): Promise<void> {
    const challenge = String(body.challenge || '').trim();
    if (challenge) {
      sendJson(res, 200, { challenge });
      return;
    }

    const expectedToken = this.config.feishu.verificationToken;
    const bodyToken = String(body.token || '').trim();
    if (expectedToken && bodyToken !== expectedToken) {
      sendJson(res, 403, { success: false, error: 'Invalid Feishu verification token' });
      return;
    }

    const event = (body.event && typeof body.event === 'object' && !Array.isArray(body.event))
      ? body.event as Record<string, unknown>
      : {};
    const header = (body.header && typeof body.header === 'object' && !Array.isArray(body.header))
      ? body.header as Record<string, unknown>
      : {};
    const eventType = String(header.event_type || body.type || '').trim();
    if (eventType !== 'im.message.receive_v1') {
      sendJson(res, 200, { success: true, ignored: true, eventType });
      return;
    }

    const message = (event.message && typeof event.message === 'object' && !Array.isArray(event.message))
      ? event.message as Record<string, unknown>
      : {};
    const sender = (event.sender && typeof event.sender === 'object' && !Array.isArray(event.sender))
      ? event.sender as Record<string, unknown>
      : {};
    const senderId = (sender.sender_id && typeof sender.sender_id === 'object' && !Array.isArray(sender.sender_id))
      ? sender.sender_id as Record<string, unknown>
      : {};
    const messageType = String(message.message_type || '').trim();
    const text = parseFeishuTextContent(message.content);
    const messageId = String(message.message_id || '').trim() || undefined;
    if (messageType !== 'text' || !text) {
      sendJson(res, 200, { success: true, ignored: true, reason: 'unsupported-message' });
      return;
    }
    if (this.isDuplicateMessage('feishu', messageId)) {
      sendJson(res, 200, { success: true, ignored: true, reason: 'duplicate' });
      return;
    }

    const inbound: AssistantDaemonIngressMessage = {
      provider: 'feishu',
      peerId: String(message.chat_id || senderId.open_id || senderId.user_id || 'feishu-chat').trim(),
      userId: String(senderId.user_id || senderId.open_id || '').trim() || undefined,
      userName: String((sender as Record<string, unknown>).sender_type || '').trim() || undefined,
      messageId,
      text,
      waitForReply: false,
      metadata: {
        chatId: String(message.chat_id || '').trim() || undefined,
        messageId,
      },
    };

    sendJson(res, 200, { success: true, accepted: true });
    void this.enqueueInboundMessage(inbound).then(async (result) => {
      try {
        await this.sendFeishuReply(inbound, result.response);
      } catch (error) {
        const messageText = extractErrorMessage(error);
        this.emitLog('error', 'Failed to send Feishu reply.', {
          error: messageText,
          chatId: inbound.metadata?.chatId,
        });
      }
    }).catch((error) => {
      this.emitLog('error', 'Failed to process Feishu inbound message.', {
        error: extractErrorMessage(error),
      });
    });
  }

  private resolveRelayAuthToken(provider: 'relay' | 'weixin'): string | undefined {
    if (provider === 'weixin') {
      return this.config.weixin.authToken || this.config.relay.authToken;
    }
    return this.config.relay.authToken;
  }

  private async handleRelayIngress(
    body: Record<string, unknown>,
    res: http.ServerResponse,
    provider: 'relay' | 'weixin',
  ): Promise<void> {
    const expectedToken = this.resolveRelayAuthToken(provider);
    const authToken = String(body.authToken || '').trim();
    if (expectedToken && authToken !== expectedToken) {
      sendJson(res, 403, { success: false, error: 'Invalid relay token' });
      return;
    }

    const inbound: AssistantDaemonIngressMessage = {
      provider: provider === 'weixin' ? 'weixin' : (String(body.provider || 'relay').trim() as AssistantChannelProvider),
      accountId: String(body.accountId || '').trim() || undefined,
      peerId: String(body.peerId || '').trim(),
      userId: String(body.userId || '').trim() || undefined,
      userName: String(body.userName || '').trim() || undefined,
      messageId: String(body.messageId || '').trim() || undefined,
      text: String(body.text || '').trim(),
      waitForReply: Boolean(body.waitForReply),
      metadata: (body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata))
        ? body.metadata as Record<string, unknown>
        : undefined,
    };

    if (!inbound.peerId || !inbound.text) {
      sendJson(res, 400, { success: false, error: 'peerId and text are required' });
      return;
    }
    if (this.isDuplicateMessage(inbound.provider, inbound.messageId)) {
      sendJson(res, 200, { success: true, ignored: true, reason: 'duplicate' });
      return;
    }

    if (!inbound.waitForReply) {
      sendJson(res, 202, { success: true, accepted: true });
      void this.enqueueInboundMessage(inbound).catch((error) => {
        this.emitLog('error', 'Failed to process relay inbound message.', {
          error: extractErrorMessage(error),
          provider: inbound.provider,
        });
      });
      return;
    }

    try {
      const result = await this.enqueueInboundMessage(inbound);
      sendJson(res, 200, {
        success: true,
        taskId: result.taskId,
        sessionId: result.sessionId,
        response: result.response,
      });
    } catch (error) {
      const message = extractErrorMessage(error);
      sendJson(res, 500, { success: false, error: message });
    }
  }

  private async enqueueInboundMessage(message: AssistantDaemonIngressMessage): Promise<AssistantDaemonProcessResult> {
    const queueKey = `${message.provider}:${message.accountId || 'default'}:${message.peerId}`;
    const previous = this.peerQueues.get(queueKey) || Promise.resolve({
      taskId: '',
      sessionId: '',
      response: '',
    });
    const next = previous
      .catch(() => ({ taskId: '', sessionId: '', response: '' }))
      .then(() => this.processInboundMessage(queueKey, message));
    this.peerQueues.set(queueKey, next);
    try {
      return await next;
    } finally {
      if (this.peerQueues.get(queueKey) === next) {
        this.peerQueues.delete(queueKey);
      }
      this.emitStatus();
    }
  }

  private async processInboundMessage(
    queueKey: string,
    message: AssistantDaemonIngressMessage,
  ): Promise<AssistantDaemonProcessResult> {
    this.inFlightKeys.add(queueKey);
    this.emitStatus();

    const task = await getBackgroundTaskRegistry().registerTask({
      kind: 'external-message',
      title: `${message.provider} message ${message.userId || message.peerId}`,
      contextId: queueKey,
    });

    const contextId = `external:${queueKey}`;
    const contextContent = [
      `provider=${message.provider}`,
      `accountId=${message.accountId || ''}`,
      `peerId=${message.peerId}`,
      `userId=${message.userId || ''}`,
    ].join('\n');

    try {
      const result = await getHeadlessAgentRunner().runRedClawTask({
        taskId: task.id,
        title: `${message.provider.toUpperCase()} ${message.userId || message.peerId}`,
        contextId,
        contextContent,
        prompt: buildRelayPrompt(message),
        displayContent: `[${message.provider}] ${message.text}`,
        runtimeMode: 'redclaw',
      });
      const summary = `Handled ${message.provider} message from ${message.userId || message.peerId}`;
      await getBackgroundTaskRegistry().completeTask(task.id, summary);
      return {
        taskId: task.id,
        sessionId: result.sessionId,
        response: result.response,
      };
    } catch (error) {
      const messageText = extractErrorMessage(error);
      await getBackgroundTaskRegistry().failTask(task.id, messageText);
      throw error;
    } finally {
      this.inFlightKeys.delete(queueKey);
      this.emitStatus();
    }
  }

  private async getFeishuTenantAccessToken(): Promise<string> {
    if (!this.config.feishu.appId || !this.config.feishu.appSecret) {
      throw new Error('Feishu appId/appSecret is not configured');
    }
    const now = Date.now();
    if (this.feishuTokenCache && this.feishuTokenCache.expiresAtMs - 60_000 > now) {
      return this.feishuTokenCache.token;
    }

    const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: this.config.feishu.appId,
        app_secret: this.config.feishu.appSecret,
      }),
    });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok || Number(payload.code || 0) !== 0) {
      throw new Error(`Feishu token request failed: ${String(payload.msg || response.statusText || 'unknown')}`);
    }
    const token = String(payload.tenant_access_token || '').trim();
    const expire = Number(payload.expire || 0);
    if (!token) {
      throw new Error('Feishu tenant_access_token is empty');
    }
    this.feishuTokenCache = {
      token,
      expiresAtMs: Date.now() + Math.max(300, expire) * 1000,
    };
    return token;
  }

  private async sendFeishuReply(message: AssistantDaemonIngressMessage, responseText: string): Promise<void> {
    const chatId = String(message.metadata?.chatId || '').trim();
    if (!chatId) {
      throw new Error('Feishu chatId is missing');
    }
    const token = await this.getFeishuTenantAccessToken();
    const body = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({
        text: responseText,
      }),
      uuid: randomUUID(),
    };
    const response = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || Number(payload.code || 0) !== 0) {
      throw new Error(`Feishu send message failed: ${String(payload.msg || response.statusText || 'unknown')}`);
    }
  }
}

let assistantDaemonService: AssistantDaemonService | null = null;

export function getAssistantDaemonService(): AssistantDaemonService {
  if (!assistantDaemonService) {
    assistantDaemonService = new AssistantDaemonService();
  }
  return assistantDaemonService;
}
