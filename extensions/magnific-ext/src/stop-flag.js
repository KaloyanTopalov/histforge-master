// Magnific HITL - stop-flag module
// Owns the global "user requested stop" signal. Writers span multiple
// target modules (host-permission, messages, runner), so the flag gets
// its own leaves-first module loaded early in the importScripts chain.

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
