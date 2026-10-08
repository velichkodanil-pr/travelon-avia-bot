// Cooperative stop flag for a graceful shutdown (SIGTERM during a deploy).
// The cycle checks stopRequested() BEFORE it starts the next supplier scan or
// request: the request in progress is finished (its chat message + state
// write), the rest is left for the next cycle. Nothing is cut in half by a
// redeploy any more.
let reason = '';

export function requestStop(why = 'stop') {
  if (!reason) reason = String(why || 'stop');
}

export function stopRequested() {
  return reason !== '';
}

export function stopReason() {
  return reason;
}

// Tests only.
export function resetStop() {
  reason = '';
}
