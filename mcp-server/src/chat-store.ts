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

  create(sessionId: string): ChatSession {
    const now = Date.now();
    const session: ChatSession = {
      sessionId,
      title: 'New chat',
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.write(session);
    return session;
  }

  get(sessionId: string): ChatSession | null {
    const p = this.path(sessionId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as ChatSession;
    } catch {
      return null;
    }
  }

  append(sessionId: string, msg: ChatMessage): void {
    const session = this.get(sessionId) ?? this.create(sessionId);
    session.messages.push(msg);
    session.updatedAt = msg.ts;
    // Derive a title from the first user message.
    if (session.title === 'New chat' && msg.role === 'user' && msg.text.trim()) {
      session.title = msg.text.trim().slice(0, 60);
    }
    this.write(session);
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
        out.push({ ...rest, messageCount: messages.length });
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
