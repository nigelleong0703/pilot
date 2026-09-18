/**
 * Visible permission page. Chrome suppresses the microphone prompt inside the
 * side panel, so the mic button opens this tab: a click → getUserMedia grants
 * the extension microphone access, then we tell the side panel it can start.
 */
const statusEl = document.getElementById('status');
const allowBtn = document.getElementById('allow');

async function request(): Promise<void> {
  if (statusEl) statusEl.textContent = 'Requesting…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    if (statusEl) statusEl.textContent = '✅ Microphone allowed. You can close this tab and go back to Pilot.';
    allowBtn?.setAttribute('disabled', 'true');
    chrome.runtime.sendMessage({ type: 'MIC_GRANTED' }).catch(() => {});
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (statusEl) {
      statusEl.textContent =
        '❌ ' + msg + ' — if you denied it earlier, enable the microphone for Pilot in ' +
        'Settings → Privacy and security → Site settings → Microphone, then reload.';
    }
  }
}

allowBtn?.addEventListener('click', () => void request());
void request();
