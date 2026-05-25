/**
 * Navigate the Suno tab in our Chrome+CDP instance to https://suno.com/create.
 * The captcha solver (sidecars/suno/captcha.py) expects the tab to be on
 * /create with the Advanced tab visible — it does NOT navigate itself. When
 * Chrome was respawned by ensure-chrome.ts (or the Phase 2 watchdog), the
 * tab loads /discover and submissions fail with "advanced_tab_not_found".
 *
 * This is a one-shot helper. A future improvement could either (a) make the
 * captcha solver navigate before form-fill, or (b) bake the navigation into
 * chrome-manager.ts after each respawn.
 */
import WebSocket from 'ws';

const CDP_PORT = Number(process.env.SUNO_CDP_PORT ?? 9333);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const TARGET_URL = 'https://suno.com/create';

async function fetchTabs(): Promise<Array<{ id: string; url: string; webSocketDebuggerUrl: string; type: string }>> {
  const r = await fetch(`${CDP_BASE}/json/list`);
  if (!r.ok) throw new Error(`CDP /json/list -> ${r.status}`);
  return (await r.json()) as Array<{ id: string; url: string; webSocketDebuggerUrl: string; type: string }>;
}

async function navigate(wsUrl: string, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP WS timeout'));
    }, 15_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url } }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (msg.error) reject(new Error(msg.error.message));
        else resolve();
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function main() {
  const tabs = await fetchTabs();
  const sunoTabs = tabs.filter((t) => t.type === 'page' && t.url.includes('suno.com'));
  if (sunoTabs.length === 0) {
    console.error('no suno.com tab in Chrome — open one first');
    process.exit(1);
  }
  // Pick the first one (usually only one) — extras are likely service-worker frames.
  const tab = sunoTabs[0];
  console.log(`navigating tab ${tab.id} from ${tab.url} -> ${TARGET_URL}`);
  await navigate(tab.webSocketDebuggerUrl, TARGET_URL);
  console.log('navigate sent. Waiting 3s for page load + auth check...');
  await new Promise((r) => setTimeout(r, 3000));
  const after = await fetchTabs();
  const updatedTab = after.find((t) => t.id === tab.id);
  console.log(`tab now at: ${updatedTab?.url ?? '?'}`);
}

main().catch((err) => {
  console.error('navigate failed:', err);
  process.exit(1);
});
