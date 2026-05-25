// YouForge Flow - control panel (popup window) opener
// Opens the popup.html in a 360x620 popup window. Reused by the toolbar
// button and the `openControlPanel` message from the popup itself.

let controlPanelWindowId = null;

chrome.action.onClicked.addListener(async () => {
  await openControlPanel();
});

async function openControlPanel() {
  if (controlPanelWindowId !== null) {
    try {
      await chrome.windows.get(controlPanelWindowId);
      await chrome.windows.update(controlPanelWindowId, { focused: true });
      return;
    } catch (e) {
      controlPanelWindowId = null;
    }
  }

  const window = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 360,
    height: 620,
    top: 100,
    left: 100
  });

  controlPanelWindowId = window.id;

  chrome.windows.onRemoved.addListener(function listener(windowId) {
    if (windowId === controlPanelWindowId) {
      controlPanelWindowId = null;
      chrome.windows.onRemoved.removeListener(listener);
    }
  });
}
