import type { ChatModelAdapter } from '@assistant-ui/react';
import { acp } from './bridge';
import { loadSettings } from './settings';

/**
 * Bridges assistant-ui's runtime to our ACP daemon over the `acp/*` channel.
 *
 * Streams two structured part kinds: `reasoning` (the agent's thought chunks,
 * rendered as a collapsible "Reasoning" block) and `text` (the reply plus tool
 * activity, rendered as markdown). Yields are throttled because markdown
 * re-parses the whole message each render.
 */
let sessionId: string | null = null;
export function resetSession() {
  sessionId = null;
  resumeTarget = null;
  // A new chat starts: clear the Pilot tab group so the next session is fresh.
  chrome.runtime.sendMessage({ type: 'CLEAR_PILOT_GROUP' }).catch(() => {});
}

/** Set by the History view to resume an existing chat instead of starting a new one. */
let resumeTarget: string | null = null;
export function resumeSession(id: string) { resumeTarget = id; }

function lastUserMessage(messages: readonly any[]): any | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i];
  }
  return null;
}
function partsToText(parts: any[]): string {
  return parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export const acpAdapter: ChatModelAdapter = {
  async *run({ messages, abortSignal }) {
    const userMsg = lastUserMessage(messages);
    const userParts: any[] = userMsg?.content ?? [];
    const text = partsToText(userParts);

    const s = await loadSettings();

    const queue: any[] = [];
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };
    const wait = () => new Promise<void>((r) => (notify = r));
    const onMsg = (m: any) => { if (m?.kind === 'ACP_UPDATE') { queue.push(m.payload); wake(); } };
    chrome.runtime.onMessage.addListener(onMsg);
    const onAbort = () => { if (sessionId) acp({ type: 'acp/cancel', sessionId }); };
    abortSignal?.addEventListener('abort', onAbort);

    // Structured parts. Reasoning + tool calls are emitted as their own part
    // kinds so the UI can group them into ONE collapsible "thinking" block
    // (like Claude/ChatGPT) instead of interleaving raw text. Consecutive
    // text/reasoning chunks append to the open part.
    type ToolStatus =
      | { type: 'running' }
      | { type: 'complete' }
      | { type: 'incomplete'; reason: 'error'; error?: unknown };
    type OutPart =
      | { type: 'text'; text: string }
      | { type: 'reasoning'; text: string }
      | {
          type: 'tool-call';
          toolCallId: string;
          toolName: string;
          args: unknown;
          argsText: string;
          status: ToolStatus;
          result?: unknown;
          isError?: boolean;
        };
    const parts: OutPart[] = [];
    const toolIndex = new Map<string, number>();
    const acpStatus = (s?: string): ToolStatus =>
      s === 'completed' ? { type: 'complete' }
        : s === 'failed' ? { type: 'incomplete', reason: 'error' }
          : { type: 'running' };
    const push = (type: 'text' | 'reasoning', text: string) => {
      if (!text) return;
      const last = parts[parts.length - 1];
      if (last && last.type === type) last.text += text;
      else parts.push({ type, text });
    };
    const emit = (final = false) => ({
      content: parts.map((p) => {
        if (p.type === 'reasoning') {
          return {
            type: 'reasoning' as const,
            text: p.text,
            // `running` keeps the disclosure live/open while tokens stream;
            // `complete` lets it settle back once the turn ends.
            status: { type: final ? ('complete' as const) : ('running' as const) },
          };
        }
        if (p.type === 'tool-call') {
          return {
            type: 'tool-call' as const,
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            args: (p.args ?? {}) as any,
            argsText: p.argsText,
            status: final && p.status.type === 'running' ? { type: 'complete' as const } : p.status,
            result: p.result,
            isError: p.isError,
          };
        }
        return { type: 'text' as const, text: p.text };
      }),
    });

    try {
      // Ensure an ACP session exists (using the agent chosen in settings).
      if (!sessionId) {
        if (resumeTarget) {
          // Resume a past chat in the current agent process.
          acp({ type: 'acp/resumeSession', sessionId: resumeTarget, agentId: s.agentId, model: s.model, effort: s.effort });
          for (;;) {
            if (!queue.length) await wait();
            let err: string | null = null;
            while (queue.length) {
              const p = queue.shift();
              if (p.type === 'acp/sessionCreated') sessionId = p.sessionId;
              else if (p.type === 'acp/error') err = p.message;
            }
            if (err) { yield { content: [{ type: 'text', text: `⚠️ ${err}` }] }; return; }
            if (sessionId) break;
          }
          resumeTarget = null;
        } else {
          const msg: any = { type: 'acp/newSession', agentId: s.agentId, model: s.model || undefined, effort: s.effort };
          if (s.byoEnabled) {
            msg.byo = {
              enabled: true,
              provider: s.byoProvider,
              model: s.byoModel.trim() || undefined,
              apiKey: s.byoApiKey.trim() || undefined,
              baseUrl: s.byoBaseUrl.trim() || undefined,
            };
          }
          if (s.agentId === 'custom') {
            msg.cmd = s.customCmd;
            msg.args = s.customArgs.trim() ? s.customArgs.trim().split(/\s+/) : [];
          }
          acp(msg);
          for (;;) {
            if (!queue.length) await wait();
            let err: string | null = null;
            while (queue.length) {
              const p = queue.shift();
              if (p.type === 'acp/sessionCreated') sessionId = p.sessionId;
              else if (p.type === 'acp/error') err = p.message;
            }
            if (err) { yield { content: [{ type: 'text', text: `⚠️ ${err}` }] }; return; }
            if (sessionId) break;
          }
        }
      }

      // Pin the tab this turn acts on + tell the agent what page it's on.
      let pageCtx = '';
      try {
        const pin: any = await chrome.runtime.sendMessage({ type: 'PIN_TAB' });
        if (pin?.url) pageCtx = `[The user is currently viewing: ${pin.title || pin.url}\n${pin.url}]\n\n`;
      } catch { /* no page context */ }

      // Append the page's interactive elements so the agent starts "self-aware"
      // of the page and doesn't have to call browser_snapshot just to see what's
      // there. (Goes in pageCtx, which is always sent as text.)
      if (s.autoElements) {
        try {
          const pe: any = await chrome.runtime.sendMessage({ type: 'PAGE_ELEMENTS' });
          const nodes: Array<{ role: string; label: string }> = pe?.nodes ?? [];
          if (nodes.length) {
            const list = nodes.map((n) => `${n.role}${n.label ? ` "${n.label}"` : ''}`).join('; ');
            pageCtx += `[Interactive elements on the current page (${nodes.length}): ${list}]\n\n`;
          }
        } catch { /* no elements */ }
      }

      // ACP content blocks: page context + the user's text/image parts.
      const blocks: any[] = [];
      if (pageCtx) blocks.push({ type: 'text', text: pageCtx });

      // Claude-like "capturing page": send a viewport screenshot so the model
      // perceives the page visually. Only in DOM mode — CDP already provides the
      // native a11y tree, so a screenshot is redundant (and Claude only shoots
      // one when the tree isn't enough).
      if (s.autoScreenshot && s.pageMode !== 'cdp') {
        try {
          const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
          const shot = tab?.windowId != null
            ? await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 })
            : undefined;
          if (shot) {
            blocks.push({ type: 'image', image: shot });
            blocks.push({ type: 'text', text: '[Viewport screenshot of the current page — use it to see the page layout.]' });
          }
        } catch { /* screenshot unavailable (e.g. chrome:// page) — text-only is fine */ }
      }

      for (const p of userParts) {
        if (p.type === 'text') blocks.push({ type: 'text', text: p.text });
        else if (p.type === 'image' && typeof p.image === 'string') {
          const m = /^data:(.+?);base64,(.*)$/.exec(p.image);
          if (m) blocks.push({ type: 'image', mimeType: m[1], data: m[2] });
        }
      }
      const hasImage = blocks.some((b) => b.type === 'image');
      acp({ type: 'acp/prompt', sessionId, text: pageCtx + text, content: hasImage ? blocks : undefined });

      let done = false;
      let lastYield = 0;
      while (!done) {
        if (!queue.length) await wait();
        while (queue.length) {
          const p = queue.shift();
          if (p.type === 'acp/update') {
            const u = p.update;
            if (u.sessionUpdate === 'agent_message_chunk') {
              push('text', u.content?.text ?? '');
            } else if (u.sessionUpdate === 'agent_thought_chunk') {
              // The agent's reasoning → its own part (grouped into "thinking").
              push('reasoning', u.content?.text ?? '');
            } else if (u.sessionUpdate === 'tool_call') {
              const id = String(u.toolCallId ?? u.title ?? parts.length);
              const part = {
                type: 'tool-call' as const,
                toolCallId: id,
                toolName: String(u.title ?? u.kind ?? 'tool'),
                args: u.rawInput ?? {},
                argsText: u.rawInput != null ? JSON.stringify(u.rawInput, null, 2) : '',
                status: acpStatus(u.status),
                isError: u.status === 'failed' || undefined,
              };
              const existing = toolIndex.get(id);
              if (existing != null) parts[existing] = part;
              else { toolIndex.set(id, parts.length); parts.push(part); }
            } else if (u.sessionUpdate === 'tool_call_update') {
              const idx = toolIndex.get(String(u.toolCallId));
              if (idx != null) {
                const part = parts[idx];
                if (part?.type === 'tool-call') {
                  if (u.title) part.toolName = String(u.title);
                  if (u.status) { part.status = acpStatus(u.status); if (u.status === 'failed') part.isError = true; }
                  if (u.rawOutput !== undefined) part.result = u.rawOutput;
                }
              }
            }
          } else if (p.type === 'acp/turnEnd') {
            done = true;
          } else if (p.type === 'acp/error') {
            push('text', `\n\n⚠️ ${p.message}`);
            done = true;
          }
        }
        const now = Date.now();
        if (done || now - lastYield >= 60) {
          lastYield = now;
          yield emit(done);
        }
      }
      if (!parts.length) push('text', '(done)');
      yield emit(true);
    } finally {
      chrome.runtime.sendMessage({ type: 'UNPIN_TAB' }).catch(() => {});
      chrome.runtime.onMessage.removeListener(onMsg);
      abortSignal?.removeEventListener('abort', onAbort);
    }
  },
};
