/**
 * Per-session chat history, persisted to disk.
 *
 * Each ACP chat session is saved as one JSON file under a data dir so
 * conversations survive daemon restarts and can be listed / reopened in the
 * side panel. This is the broker-side source of truth for transcripts; ACP's
 * own session/load handles resuming the *agent's* context.
 *
 *   <dataDir>/sessions/<sessionId>.json
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'plan';
  text: string;
  ts: number;
}

export interface ChatSession {
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /** How the session was launched, so History "Continue" resumes the same agent. */
  agentId?: string;
  model?: string;
  effort?: string;
  cmd?: string;
  args?: string[];
}

/** The page-context prefix the side panel injects before the user's message. */
const CONTEXT_PREFIX = /^\[The user is currently viewing:[\s\S]*?\]\s*/;

/** Strip the injected page-context block so titles/transcripts show what the user typed. */
export function stripContext(text: string): string {
  return text.replace(CONTEXT_PREFIX, '').trim();
}

/** True for titles that captured the injected context (legacy, possibly truncated). */
const looksPrefixed = (t: string) => t.startsWith('[The user is currently viewing:');

/** Recover a readable title from the first real user message when needed. */
function deriveTitle(s: ChatSession): string {
  if (s.title && !looksPrefixed(s.title)) return s.title;
  const first = s.messages.find((m) => m.role === 'user' && stripContext(m.text));
  if (first) return stripContext(first.text).slice(0, 60);
  return stripContext(s.title) || 'Chat';
}

export class ChatStore {
  private dir: string;

  constructor(dataDir?: string) {
    const base = dataDir ?? join(homedir(), '.browser-extension-agent');
    this.dir = join(base, 'sessions');
    mkdirSync(this.dir, { recursive: true });
  }

  private path(sessionId: string) {
    return join(this.dir, `${sessionId}.json`);
  }

  create(sessionId: string, meta: Partial<ChatSession> = {}): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      sessionId,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
      ...meta,
    };
    this.write(session);
    return session;
  }

  get(sessionId: string): ChatSession | null {
    const p = this.path(sessionId);
    if (!existsSync(p)) return null;
    try {
      const s = JSON.parse(readFileSync(p, 'utf8')) as ChatSession;
      // Clean legacy page-context prefixes for display + titles.
      s.messages = s.messages.map((m) =>
        m.role === 'user' ? { ...m, text: stripContext(m.text) } : m,
      );
      s.title = deriveTitle(s);
      return s;
    } catch {
      return null;
    }
  }

  append(sessionId: string, msg: ChatMessage): void {    const session = this.get(sessionId) ?? this.create(sessionId);
    const stored = msg.role === 'user' ? { ...msg, text: stripContext(msg.text) } : msg;
    session.messages.push(stored);
    session.updatedAt = msg.ts;
    // Derive a title from the first user message (page context stripped).
    if (session.title === 'New chat' && stored.role === 'user' && stored.text.trim()) {
      session.title = stored.text.trim().slice(0, 60);
    }
    this.write(session);
  }

  /** Update session metadata (e.g. which agent to resume with) without touching messages. */
  setMeta(sessionId: string, meta: Partial<ChatSession>): void {
    const s = this.get(sessionId);
    if (!s) return;
    Object.assign(s, meta, { sessionId: s.sessionId });
    this.write(s);
  }

  /** Newest first, without message bodies — for the sidebar list. */
  list(): Array<Omit<ChatSession, 'messages'> & { messageCount: number }> {
    if (!existsSync(this.dir)) return [];
    const out: Array<Omit<ChatSession, 'messages'> & { messageCount: number }> = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as ChatSession;
        const { messages, ...rest } = s;
        out.push({ ...rest, title: deriveTitle(s), messageCount: messages.length });
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private write(session: ChatSession) {
    writeFileSync(this.path(session.sessionId), JSON.stringify(session, null, 2), 'utf8');
  }
}
