// keepalive.mjs — keep the MV3 service worker reconnecting and alive.
//
// Two independent mechanisms (BUILD_SPEC §3):
//   1. startKeepalive: a chrome.alarms timer (every 1 min) that nudges the
//      WSClient to reconnect. Alarms survive SW suspension, so even after the
//      worker is torn down it gets woken to re-establish the link.
//   2. beginHeartbeat/endHeartbeat: an in-flight ref-counter. While any tool
//      call is running we poke a cheap chrome API every 20s so Chrome doesn't
//      suspend the worker mid-operation. The interval is cleared once the last
//      in-flight call completes.

const RECONNECT_ALARM = "awb-reconnect";

export function startKeepalive(reconnectFn) {
  chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === RECONNECT_ALARM) reconnectFn();
  });
}

let inflight = 0;
let hb = null;

export function beginHeartbeat() {
  inflight++;
  if (!hb) {
    hb = setInterval(() => {
      chrome.runtime.getPlatformInfo(() => {});
    }, 20000);
  }
}

export function endHeartbeat() {
  inflight--;
  if (inflight <= 0) {
    inflight = 0;
    if (hb) {
      clearInterval(hb);
      hb = null;
    }
  }
}
