// YouForge Flow - stop-flag module
// Owns the global "user requested stop" signal. Replaces the inline
// `globalStopFlag` variable that lived in background.js, along with its
// 7 throw sites, 7 mutations, and 11 reads.
//
// Writers span multiple target modules (webhook.notifySessionExpired,
// host-permission.halt_onHostRemoved, messages.js stop handlers,
// runner.startPolling), so the flag gets its own leaves-first module
// loaded early in the importScripts chain.

let _stopFlag = false;

function getStopFlag() {
  return _stopFlag;
}

function setStopFlag() {
  _stopFlag = true;
}

function clearStopFlag() {
  _stopFlag = false;
}

function assertNotStopped() {
  if (_stopFlag) throw new Error('STOP_REQUESTED');
}
