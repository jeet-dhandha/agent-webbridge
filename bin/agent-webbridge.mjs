#!/usr/bin/env node
// agent-webbridge.mjs — the installed binary AWB_DAEMON_BIN points at.
// Thin shim: all CLI logic lives in src/daemon/index.mjs.
import "../src/daemon/index.mjs";
