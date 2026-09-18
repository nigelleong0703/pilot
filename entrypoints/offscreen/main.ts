/**
 * Offscreen document — OWNS the persistent WebSocket to the daemon.
 *
 * Offscreen documents live for the extension's lifetime (unlike the MV3 service
 * worker, which is reaped after ~30s idle), so holding the socket here means the
 * bridge never drops when the SW sleeps. This document can't call chrome.tabs /
 * chrome.debugger, so browser commands are relayed to the SW (EXEC) which runs
 * the CDP/DOM work and replies.
 *
 *   daemon --ws:9234--> offscreen --EXEC--> SW (CDP/tabs) --> reply --> offscreen
 *   daemon --acp/*----> offscreen --ACP_UPDATE--> side panel
 *   side panel --ACP_SEND--> offscreen --ws--> daemon
 */
import { BRIDGE_PORT } from '../../lib/protocol';

let ws: WebSocket | null = null;

function status(connected: boolean) {
  chrome.runtime.sendMessage({ kind: 'BRIDGE_STATUS', connected }).catch(() => {});
}

function connect() {
  try {
    ws = new WebSocket(`ws://localhost:${BRIDGE_PORT}`);
  } catch {
    setTimeout(connect, 1500);
    return;
  }

  ws.addEventListener('open', () => status(true));

  ws.addEventListener('message', (ev) => {
    let msg: any;
    try { msg = JSON.parse(ev.data as string); } catch { return; }

    if (msg.type === 'ping') return; // daemon keepalive
    // Chat / ACP push → side panel.
    if (typeof msg.type === 'string' && msg.type.startsWith('acp/')) {
      chrome.runtime.sendMessage({ kind: 'ACP_UPDATE', payload: msg }).catch(() => {});
      return;
    }
    // Browser command → have the SW execute it, then send the reply back.
    chrome.runtime.sendMessage({ kind: 'EXEC', req: msg }, (reply) => {
      if (chrome.runtime.lastError || !reply) {
        ws?.send(JSON.stringify({ id: msg.id, ok: false, error: 'Service worker unavailable — retry' }));
        return;
      }
      ws?.send(JSON.stringify(reply));
    });
  });

  ws.addEventListener('close', () => { status(false); setTimeout(connect, 1500); });
  ws.addEventListener('error', () => ws?.close());
}

connect();

chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  // Side panel (or SW bglog) sending up to the daemon.
  if (msg?.kind === 'ACP_SEND') {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg.payload));
    } else {
      chrome.runtime
        .sendMessage({ kind: 'ACP_UPDATE', payload: { type: 'acp/error', message: 'Bridge offline — is the daemon running?' } })
        .catch(() => {});
    }
    return;
  }
  if (msg?.kind === 'OFFSCREEN_PING') {
    sendResponse({ connected: ws?.readyState === WebSocket.OPEN });
    return;
  }
});
