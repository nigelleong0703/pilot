import type { RecordedStep } from '../background';

export type { RecordedStep };

/** A chat message as rendered in the UI. */
export interface ChatMsg {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'thought' | 'plan' | 'error';
  text: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface PermissionState {
  requestId: number;
  options: Array<{ optionId: string; name: string; kind?: string }>;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  messageCount: number;
  updatedAt: number;
}

let counter = 0;
export const uid = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Fire-and-forget message to the background/offscreen. */
export function post(message: unknown): void {
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** Await a response from the background (used for GET_STATE etc.). */
export function request<T = any>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message);
}

/** Send a chat / ACP message up to the daemon (via offscreen). */
export function acp(payload: unknown): void {
  post({ kind: 'ACP_SEND', payload });
}
