#!/usr/bin/env node
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const INSTALL_URL = "https://app.primeintellect.ai/prime-agent/install.sh";

function findPrimeAgentBinary() {
  const home = homedir();
  const candidates = [
    process.env.PRIME_AGENT_BIN,
    path.join(home, ".local/bin/prime-agent"),
    path.join(home, ".prime/bin/prime-agent"),
    path.join(home, ".prime/agent/bin/prime-agent"),
    "/opt/homebrew/bin/prime-agent",
    "/usr/local/bin/prime-agent",
    "/usr/bin/prime-agent",
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  try {
    const out = execFileSync("which", ["prime-agent"], { encoding: "utf8" });
    const resolved = out.trim().split("\n")[0];
    if (resolved && existsSync(resolved)) return resolved;
  } catch {}

  return null;
}

function installerEnv() {
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

function installPrimeAgentSync() {
  try {
    process.stderr.write(
      `[bb-plugin-prime-agent-acp] Downloading and installing prime-agent from ${INSTALL_URL}\n`,
    );
    execFileSync("sh", ["-c", `curl -fsSL ${INSTALL_URL} | sh`], {
      stdio: "inherit",
      env: installerEnv(),
      timeout: 180000,
    });
    return findPrimeAgentBinary();
  } catch (err) {
    process.stderr.write(`[bb-plugin-prime-agent-acp] Install failed: ${err.message}\n`);
    return null;
  }
}

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@%+/-]*$/;

const argv = process.argv.slice(2);

// Handle explicit install command
if (argv[0] === "--install" || argv[0] === "install") {
  const yes = argv.includes("--yes");
  if (!yes) {
    console.error(
      [
        "This downloads and executes a shell script from Prime Intellect:",
        `  ${INSTALL_URL}`,
        "It installs the official prime-agent binary into your home directory.",
        "",
        "Re-run with --yes to confirm: `bb prime-agent install --yes`",
      ].join("\n"),
    );
    process.exit(1);
  }
  const bin = installPrimeAgentSync();
  if (bin) {
    console.log(`Prime Agent successfully installed at: ${bin}`);
    process.exit(0);
  } else {
    console.error("Failed to install Prime Agent.");
    process.exit(1);
  }
}

// Handle model list command
if (argv.includes("--list-models") || (argv[0] === "model" && argv[1] === "list")) {
  const bin = findPrimeAgentBinary();
  if (!bin) {
    console.error(
      "prime-agent binary not found. Install it explicitly first: `bb prime-agent install`.",
    );
    process.exit(1);
  }

  let text = "";
  try {
    const r = spawnSync(bin, ["model", "list"], { encoding: "utf8", timeout: 30000 });
    text = (r.stdout || "") + (r.stderr || "");
  } catch (err) {
    console.error(`Failed to list models: ${err.message}`);
    process.exit(1);
  }

  if (!text) {
    process.exit(1);
  }

  const seen = new Set();
  let emitted = 0;
  for (const line of text.split("\n")) {
    if (/^\s*provider\s+model/i.test(line) || line.startsWith("-")) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const provider = cols[0];
    const id = cols[1];
    if (!provider || !MODEL_ID_PATTERN.test(provider) || !MODEL_ID_PATTERN.test(id)) continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isFree = id.toLowerCase().includes("free");
    const tag = isFree ? " · FREE" : "";
    console.log(`${key} - ${id}${tag} (${provider})`);
    emitted++;
  }
  if (emitted === 0) {
    console.error("No models parsed from `prime-agent model list` output.");
    process.exit(1);
  }
  process.exit(0);
}

// Launch prime-agent in ACP mode
const bin = findPrimeAgentBinary();
if (!bin) {
  console.error(
    "prime-agent binary not found. Install it explicitly first: `bb prime-agent install`.",
  );
  process.exit(1);
}

const lastValue = (flag) => {
  const i = argv.lastIndexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const model = lastValue("--model");
const thinking = lastValue("--thinking");
const slash = model ? model.indexOf("/") : -1;
const provider = lastValue("--provider") ?? (slash > 0 ? model.slice(0, slash) : undefined);
const modelId = slash > 0 ? model.slice(slash + 1) : model;

const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--model" || a === "--thinking" || a === "--provider") {
    i++;
    continue;
  }
  rest.push(a);
}

if (!rest.includes("--mode")) {
  rest.push("--mode", "acp");
}

const childArgs = [
  ...rest,
  ...(provider ? ["--provider", provider] : []),
  ...(modelId ? ["--model", modelId] : []),
  ...(thinking ? ["--thinking", thinking] : []),
];

const child = spawn(bin, childArgs, {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

const pendingRequests = new Map();

const stdinRl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

stdinRl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg && msg.id !== undefined && msg.method) {
      pendingRequests.set(msg.id, {
        line,
        method: msg.method,
        retries: 0,
      });
    }
  } catch {}

  child.stdin.write(line + "\n");
});

process.stdin.on("end", () => {
  child.stdin.end();
});

const stdoutRl = readline.createInterface({
  input: child.stdout,
  terminal: false,
});

stdoutRl.on("line", (line) => {
  let isHandled = false;
  try {
    const msg = JSON.parse(line);
    if (msg && msg.id !== undefined && pendingRequests.has(msg.id)) {
      const req = pendingRequests.get(msg.id);
      const errStr = msg.error ? JSON.stringify(msg.error) : "";

      // Retry prompt if agent is still settling previous cancellation
      if (msg.error && errStr.includes("is cancelling")) {
        if (req.retries < 20) {
          req.retries++;
          setTimeout(() => {
            if (!child.killed && child.stdin.writable) {
              child.stdin.write(req.line + "\n");
            }
          }, 200);
          isHandled = true;
        } else {
          pendingRequests.delete(msg.id);
        }
      } else {
        pendingRequests.delete(msg.id);
      }
    }
  } catch {}

  if (!isHandled) {
    process.stdout.write(line + "\n");
  }
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
