/**
 * One-shot CDP listener that captures the next /api/generate POST body the
 * Suno tab sends. The user triggers a generation in their browser; this
 * script prints the full request body to stdout, including the `mv` value
 * and any persona-related fields (artist_clip_id, artist_start_s, etc).
 *
 * Why bother: the Payload tab in DevTools wraps lines and partial copies
 * keep losing the top of the body. CDP's Network.requestWillBeSent gives
 * us the body in one shot, no copy/paste needed.
 *
 * Usage:
 *   1. Run: npx tsx scripts/capture-suno-create-payload.ts
 *   2. In the browser, with Kane Victor persona selected, click Create
 *   3. The body is printed here; ctrl-c to exit
 */
import WebSocket from 'ws';

const CDP_PORT = Number(process.env.SUNO_CDP_PORT ?? 9333);
const TARGET_PATH_FRAGMENT = '/api/generate';

async function fetchTabs(): Promise<Array<{ id: string; url: string; webSocketDebuggerUrl: string; type: string }>> {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return (await r.json()) as Array<{ id: string; url: string; webSocketDebuggerUrl: string; type: string }>;
}

async function main() {
  const tabs = await fetchTabs();
  const sunoTab = tabs.find((t) => t.type === 'page' && t.url.includes('suno.com'));
  if (!sunoTab) {
    console.error('No suno.com tab found in Chrome. Open suno.com/create first.');
    process.exit(1);
  }
  console.log(`Listening on tab: ${sunoTab.url}`);
  console.log(`Trigger a generation in the browser (with Kane Victor persona selected).`);
  console.log(`Press Ctrl+C when done.\n`);

  const ws = new WebSocket(sunoTab.webSocketDebuggerUrl);
  let nextId = 1;

  ws.on('open', () => {
    ws.send(JSON.stringify({ id: nextId++, method: 'Network.enable' }));
  });

  ws.on('message', (data) => {
    let msg: {
      method?: string;
      params?: {
        request?: { url?: string; method?: string; postData?: string; hasPostData?: boolean };
        requestId?: string;
      };
    };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.method !== 'Network.requestWillBeSent') return;
    const req = msg.params?.request;
    if (!req?.url || !req.url.includes(TARGET_PATH_FRAGMENT)) return;
    if (req.method !== 'POST') return;

    console.log('============================================================');
    console.log('Captured POST', req.url);
    console.log('============================================================');
    if (req.postData) {
      try {
        const parsed = JSON.parse(req.postData);
        console.log(JSON.stringify(parsed, null, 2));
      } catch {
        console.log(req.postData);
      }
    } else if (req.hasPostData && msg.params?.requestId) {
      // Body too large to inline; ask CDP for it. Bind the listener BEFORE
      // sending so we don't race the response (would-be 0% chance in practice
      // since the round-trip is multiple event-loop ticks, but the inverted
      // order is the more-correct shape).
      const id = nextId++;
      const replyId = id;
      ws.once('message', (d) => {
        try {
          const m = JSON.parse(d.toString()) as { id?: number; result?: { postData?: string } };
          if (m.id === replyId && m.result?.postData) {
            try {
              console.log(JSON.stringify(JSON.parse(m.result.postData), null, 2));
            } catch {
              console.log(m.result.postData);
            }
          }
        } catch {
          /* ignore */
        }
      });
      ws.send(
        JSON.stringify({
          id,
          method: 'Network.getRequestPostData',
          params: { requestId: msg.params.requestId },
        }),
      );
    } else {
      console.log('(no postData on this event)');
    }
    console.log('');
  });

  ws.on('error', (err) => {
    console.error('CDP WS error:', err.message);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
