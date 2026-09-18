// Shared message contracts for the MCP <-> extension WebSocket bridge and for
// the background <-> content-script command channel.

/** Default port the MCP server listens on and the extension connects to. */
export const BRIDGE_PORT = 9234;

/** A command the MCP server asks the extension to perform. */
export interface BridgeRequest {
  id: string;
  method: BridgeMethod;
  params?: Record<string, unknown>;
  /** Identifies the MCP session so each gets its own isolated tab + group. */
  session?: { id: string; label: string };
}

/** The extension's reply for a given request id. */
export interface BridgeResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export type BridgeMethod =
  | 'navigate'
  | 'pageContext'
  | 'screenshot'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'selectOption'
  | 'getText'
  | 'recorder.start'
  | 'recorder.stop'
  | 'recorder.clear'
  | 'recorder.getSteps';

// ── Chat / ACP channel (side panel <-> daemon, over the same 9234 socket) ────
// The side panel is the ACP "front end"; the daemon runs the agent. These
// envelopes ride the extension<->daemon WebSocket alongside browser commands
// and are distinguished by a `type` starting with "acp/".

/** Sent from the side panel (via offscreen) to the daemon. */
export type AcpClientMessage =
  | { type: 'acp/newSession'; agentId?: string; cmd?: string; args?: string[]; model?: string; thinking?: boolean }
  | { type: 'acp/prompt'; sessionId: string; text: string; content?: unknown[] }
  | { type: 'acp/cancel'; sessionId: string }
  | { type: 'acp/permission'; requestId: number; optionId: string | null }
  | { type: 'acp/listSessions' }
  | { type: 'acp/loadSession'; sessionId: string }
  | { type: 'acp/listSkills' }
  | { type: 'acp/skillFromRecording'; sessionId: string; steps: unknown[] };

/** Pushed from the daemon to the side panel. */
export type AcpServerMessage =
  | { type: 'acp/sessionCreated'; sessionId: string }
  | { type: 'acp/update'; sessionId: string; update: Record<string, unknown> }
  | { type: 'acp/turnEnd'; sessionId: string; stopReason: string }
  | { type: 'acp/permissionRequest'; sessionId: string; requestId: number; toolCall: unknown; options: Array<{ optionId: string; name: string; kind?: string }> }
  | { type: 'acp/sessions'; sessions: unknown[] }
  | { type: 'acp/history'; sessionId: string; messages: unknown[] }
  | { type: 'acp/skills'; skills: unknown[]; commands: unknown[] }
  | { type: 'acp/error'; sessionId?: string; message: string };

/** Methods the background forwards to the active tab's content script. */
export type PageMethod = 'snapshot' | 'click' | 'type' | 'selectOption' | 'getText';

/** Envelope sent from background -> content script. */
export interface PageCommand {
  kind: 'COMMAND';
  method: PageMethod;
  params?: Record<string, unknown>;
}

/** One interactive element returned by a page snapshot. */
export interface SnapshotNode {
  ref: number;
  role: string;
  label: string;
  value?: string;
  tag: string;
}
