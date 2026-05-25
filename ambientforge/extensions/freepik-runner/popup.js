async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'freepik:get-state' });
  const badge = document.getElementById('status-badge');
  // Polling is now ALWAYS-ON (background.js ignores isEnabled; freepik-login.ts
  // force-drives the worker). The old idle/enabled badge was misleading —
  // always show always-on so the operator isn't told it's "not enabled".
  badge.textContent = 'polling (always-on)';
  badge.classList.add('on');
  document.getElementById('toggle').textContent = 'Always-on (no toggle)';
  document.getElementById('processed').textContent = String(state?.stats?.processed ?? 0);
  document.getElementById('failed').textContent = String(state?.stats?.failed ?? 0);
}

document.getElementById('toggle').addEventListener('click', async () => {
  const state = await chrome.runtime.sendMessage({ type: 'freepik:get-state' });
  await chrome.runtime.sendMessage({
    type: 'freepik:set-enabled',
    enabled: !state?.isEnabled,
  });
  refresh();
});

refresh();
