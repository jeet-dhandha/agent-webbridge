// registry.mjs — single-extension connection registry.
// Holds the daemon's view of the currently connected extension (id + version)
// so the WS hub and HTTP /status endpoint share one source of truth.
// Mutable module-level singleton; pure state, no I/O.

export const registry = {
  connected: false,
  extensionId: null,
  extensionVersion: null,
};

// Mark the extension as connected, recording its id/version from the hello payload.
export function setConnected({ extensionId, extensionVersion } = {}) {
  registry.connected = true;
  registry.extensionId = extensionId ?? null;
  registry.extensionVersion = extensionVersion ?? null;
}

// Reset the registry to the disconnected state.
export function setDisconnected() {
  registry.connected = false;
  registry.extensionId = null;
  registry.extensionVersion = null;
}

// Flatten the registry into the fields the /status response embeds.
export function statusFields() {
  return {
    extension_connected: registry.connected,
    extension_id: registry.extensionId || "",
    extension_version: registry.extensionVersion || "",
  };
}
