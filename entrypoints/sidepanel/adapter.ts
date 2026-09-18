import type { ChatModelAdapter } from '@assistant-ui/react';
import { acp } from './bridge';
import { loadSettings } from './settings';

/**
 * Bridges assistant-ui's runtime to our ACP daemon over the `acp/*` channel.
 *
 * Text-only streaming (one text part) for stability: structured reasoning /
 * tool-call parts can crash assistant-ui's renderer during heavy streaming, so
 * we fold thinking + tool activity into the text. Yields are throttled because
 * markdown re-parses the whole message each render.
 */
let sessionId: string | null = null;
export function resetSession() { sessionId = null; }

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

    const queue: any[] = [];
    let notify: (() => void) | null = null;
    const wake = () => { const n = notify; notify = null; n?.(); };
    const wait = () => new Promise<void>((r) => (notify = r));
    const onMsg = (m: any) => { if (m?.kind === 'ACP_UPDATE') { queue.push(m.payload); wake(); } };
    chrome.runtime.onMessage.addListener(onMsg);
    const onAbort = () => { if (sessionId) acp({ type: 'acp/cancel', sessionId }); };
    abortSignal?.addEventListener('abort', onAbort);

    let out = '';       // streamed assistant text (what the UI shows)
    const emit = () => ({ content: [{ type: 'text' as const, text: out }] });

    try {
      // Ensure an ACP session exists (using the agent chosen in settings).
      if (!sessionId) {
        const s = await loadSettings();
        const msg: any = { type: 'acp/newSession', agentId: s.agentId, model: s.model || undefined, thinking: s.thinking };
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

      // Pin the tab this turn acts on + tell the agent what page it's on.
      let pageCtx = '';
      try {
        const pin: any = await chrome.runtime.sendMessage({ type: 'PIN_TAB' });
        if (pin?.url) pageCtx = `[The user is currently viewing: ${pin.title || pin.url}\n${pin.url}]\n\n`;
      } catch { /* no page context */ }

      // ACP content blocks: page context + the user's text/image parts.
      const blocks: any[] = [];
      if (pageCtx) blocks.push({ type: 'text', text: pageCtx });
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
      let sawText = false;
      while (!done) {
        if (!queue.length) await wait();
        while (queue.length) {
          const p = queue.shift();
          if (p.type === 'acp/update') {
            const u = p.update;
            if (u.sessionUpdate === 'agent_message_chunk') {
              out += u.content?.text ?? '';
              sawText = true;
            } else if (u.sessionUpdate === 'tool_call' && u.title) {
              out += `${out && !out.endsWith('\n') ? '\n' : ''}\n\u{1F527} ${u.title}\n`;
            }
            // reasoning (agent_thought_chunk) intentionally not rendered here.
          } else if (p.type === 'acp/turnEnd') {
            done = true;
          } else if (p.type === 'acp/error') {
            out += `\n\n⚠️ ${p.message}`;
            done = true;
          }
        }
        const now = Date.now();
        if (done || now - lastYield >= 60) {
          lastYield = now;
          yield emit();
        }
      }
      if (!sawText && !out) out = '(done)';
      yield emit();
    } finally {
      chrome.runtime.sendMessage({ type: 'UNPIN_TAB' }).catch(() => {});
      chrome.runtime.onMessage.removeListener(onMsg);
      abortSignal?.removeEventListener('abort', onAbort);
    }
  },
};
