const BRIDGE_HEALTH = 'http://localhost:7342/health';
const REFRESH_MS = 2000;

const dot = document.getElementById('dot');
const label = document.getElementById('label');
const info = document.getElementById('info');

async function refresh() {
  try {
    const res = await fetch(BRIDGE_HEALTH, { cache: 'no-store' });
    if (!res.ok) throw new Error('status ' + res.status);
    const data = await res.json();
    dot.className = 'dot ok';
    label.textContent = 'Connected';
    info.textContent = `queue=${data.queueDepth} inFlight=${data.inFlight} waiters=${data.waiters}`;
  } catch (err) {
    dot.className = 'dot err';
    label.textContent = 'Bridge offline';
    info.textContent = 'Run `npm run distrokid:bridge` from the project root.';
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
