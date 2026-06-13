// popup.js — Agent WebBridge popup controller.
// On load it sends {type:"GET_STATUS"} to the background service worker; this
// message is the SW wake trigger that the fleet relies on (do not remove).
// Renders connection state and wires the Connect / Disconnect buttons, which
// send {type:"CONNECT"} / {type:"DISCONNECT"} to the background.

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const connectBtn = document.getElementById("connect");
const disconnectBtn = document.getElementById("disconnect");

function render(r) {
  const connected = !!(r && r.connected);
  dot.classList.toggle("on", connected);
  dot.classList.toggle("off", !connected);
  statusText.textContent = connected ? "Connected" : "Disconnected";
  connectBtn.disabled = connected;
  disconnectBtn.disabled = !connected;
}

function refresh() {
  // GET_STATUS doubles as the service-worker wake trigger.
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
    if (chrome.runtime.lastError) {
      render({ connected: false });
      return;
    }
    render(r);
  });
}

connectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CONNECT" }, () => {
    void chrome.runtime.lastError;
    setTimeout(refresh, 300);
  });
});

disconnectBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DISCONNECT" }, () => {
    void chrome.runtime.lastError;
    setTimeout(refresh, 300);
  });
});

refresh();
