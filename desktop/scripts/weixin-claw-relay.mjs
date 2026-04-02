#!/usr/bin/env node

import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs/promises';
import path from 'node:path';

const relayUrl = process.env.REDCONVERT_RELAY_URL || 'http://127.0.0.1:31937/hooks/weixin/relay';
const relayToken = process.env.REDCONVERT_RELAY_TOKEN || '';
const accountId = process.env.WEIXIN_CLAW_ACCOUNT_ID || '';
const pollTimeoutMs = Math.max(5_000, Number(process.env.WEIXIN_CLAW_POLL_TIMEOUT_MS || 35_000));
const retryDelayMs = Math.max(1_000, Number(process.env.WEIXIN_CLAW_RETRY_DELAY_MS || 3_000));
const cursorFile = process.env.WEIXIN_CLAW_CURSOR_FILE || '';

async function loadCursorState() {
  if (!cursorFile) return { syncCursor: '' };
  try {
    const raw = await fs.readFile(cursorFile, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      syncCursor: String(parsed?.syncCursor || '').trim(),
    };
  } catch {
    return { syncCursor: '' };
  }
}

async function saveCursorState(syncCursor) {
  if (!cursorFile) return;
  await fs.mkdir(path.dirname(cursorFile), { recursive: true });
  await fs.writeFile(cursorFile, JSON.stringify({ syncCursor }, null, 2), 'utf-8');
}

const textFromItems = (items) => {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => String(item?.text_item?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

async function loadWeixinRuntime() {
  try {
    const [{ getUpdates }, { resolveWeixinAccount }, { sendMessageWeixin }] = await Promise.all([
      import('@weixin-claw/core/api/api.js'),
      import('@weixin-claw/core/auth/accounts.js'),
      import('@weixin-claw/core/messaging/send.js'),
    ]);
    return { getUpdates, resolveWeixinAccount, sendMessageWeixin };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load @weixin-claw/core. Install it under Node >=22 first. ${message}`);
  }
}

async function postToRelay(payload) {
  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...payload,
      authToken: relayToken,
      waitForReply: true,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success === false) {
    throw new Error(`Relay request failed: ${body?.error || response.statusText || 'unknown error'}`);
  }
  return String(body?.response || '').trim();
}

async function main() {
  const { getUpdates, resolveWeixinAccount, sendMessageWeixin } = await loadWeixinRuntime();
  const resolved = resolveWeixinAccount(accountId || undefined);
  if (!resolved?.configured || !resolved?.token) {
    throw new Error('No configured Weixin account found. Complete QR login with @weixin-claw/core first.');
  }

  console.log('[weixin-claw-relay] started', {
    relayUrl,
    accountId: resolved.accountId,
    baseUrl: resolved.baseUrl,
    cursorFile: cursorFile || '(memory-only)',
  });

  const cursorState = await loadCursorState();
  let syncCursor = cursorState.syncCursor;
  while (true) {
    try {
      const updates = await getUpdates({
        baseUrl: resolved.baseUrl,
        token: resolved.token,
        timeoutMs: pollTimeoutMs,
        get_updates_buf: syncCursor,
      });
      if (typeof updates?.get_updates_buf === 'string') {
        syncCursor = updates.get_updates_buf;
        await saveCursorState(syncCursor);
      }
      const messages = Array.isArray(updates?.msgs) ? updates.msgs : [];
      for (const message of messages) {
        if (Number(message?.message_type) !== 1) continue;
        const text = textFromItems(message?.item_list);
        const peerId = String(message?.from_user_id || '').trim();
        if (!peerId || !text) continue;

        const reply = await postToRelay({
          provider: 'weixin',
          accountId: resolved.accountId,
          peerId,
          userId: peerId,
          messageId: String(message?.message_id || '').trim(),
          text,
          metadata: {
            contextToken: String(message?.context_token || '').trim(),
            sessionId: String(message?.session_id || '').trim(),
          },
        });
        if (!reply) continue;

        await sendMessageWeixin({
          to: peerId,
          text: reply,
          opts: {
            baseUrl: resolved.baseUrl,
            token: resolved.token,
            contextToken: String(message?.context_token || '').trim() || undefined,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[weixin-claw-relay] loop error:', message);
      await delay(retryDelayMs);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[weixin-claw-relay] fatal:', message);
  process.exitCode = 1;
});
