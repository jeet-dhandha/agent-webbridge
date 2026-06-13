// index.mjs — the daemon CLI: `start`, `stop`, `status`.
//
// `start` self-backgrounds: the foreground invocation re-spawns this same file
// detached with AWB_CHILD=1 and exits, so the caller (fleet/router/user) gets its
// shell back immediately. The detached child is the one that actually listens and
// writes the pid file once it's up.
//
//   start [--addr host:port]   spawn detached daemon (default 127.0.0.1:10086)
//   stop  [--addr host:port]   POST /shutdown, then SIGTERM the pid as a fallback
//   status[--addr host:port]   GET /status and print the JSON

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";
import { writePidFile, removePidFile, pidFilePath } from "./lifecycle.mjs";

const thisFile = fileURLToPath(import.meta.url);

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 10086;

// Pull "--addr host:port" out of argv; fall back to the default daemon address.
function parseAddr(argv) {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  const i = argv.indexOf("--addr");
  if (i !== -1 && argv[i + 1]) {
    const [h, p] = argv[i + 1].split(":");
    if (h) host = h;
    if (p) port = Number(p);
  }
  return { host, port };
}

// Small JSON HTTP helper for stop/status (no deps).
function request(method, host, port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ method, host, port, path }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function cmdStart(argv, host, port) {
  if (process.env.AWB_CHILD !== "1") {
    // Foreground: re-spawn ourselves detached, then exit so the caller returns.
    const child = spawn(process.execPath, [thisFile, ...argv.slice(2)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AWB_CHILD: "1" },
    });
    child.unref();
    process.exit(0);
    return;
  }

  // Detached child: actually start the server and record the pid once we're listening.
  const { server } = startServer({ host, port });
  server.once("listening", () => {
    try { writePidFile(); } catch {}
  });

  const shutdown = () => {
    try { removePidFile(); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

async function cmdStop(host, port) {
  // Best effort: ask the daemon to shut itself down cleanly first.
  try {
    await request("POST", host, port, "/shutdown");
  } catch {}
  // Fallback: if a pid file points at a live process, SIGTERM it.
  try {
    const pid = Number(fs.readFileSync(pidFilePath(), "utf8").trim());
    if (pid) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  } catch {}
  try { removePidFile(); } catch {}
}

async function cmdStatus(host, port) {
  try {
    const { body } = await request("GET", host, port, "/status");
    process.stdout.write(body.endsWith("\n") ? body : body + "\n");
  } catch (e) {
    process.stdout.write(
      JSON.stringify({ running: false, error: e.message }) + "\n"
    );
  }
}

async function main() {
  const argv = process.argv;
  const sub = argv[2];
  const { host, port } = parseAddr(argv);

  switch (sub) {
    case "start":
      await cmdStart(argv, host, port);
      break;
    case "stop":
      await cmdStop(host, port);
      process.exit(0);
      break;
    case "status":
      await cmdStatus(host, port);
      process.exit(0);
      break;
    default:
      process.stdout.write(
        "usage: agent-webbridge <start|stop|status> [--addr host:port]\n"
      );
      process.exit(sub ? 1 : 0);
  }
}

main();
