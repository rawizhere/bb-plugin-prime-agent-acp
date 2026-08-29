#!/usr/bin/env node
// Launcher for the Prime Agent ACP provider.
//
// This script never installs Prime Agent implicitly. Finding the binary is a
// read-only lookup; installation happens only through the explicit
// `bb prime-agent install` command (which requires `--yes` and prints the
// URL before downloading).
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
  } catch {
    // not on PATH
  }

  return null;
}

// A minimal environment for the downloaded installer script. The bb
// server/daemon environment routinely holds API keys and tokens; none of
// them should reach a script fetched over the network. The installer also
// honours PRIME_AGENT_DOWNLOAD_BASE_URL, so deliberately not passing it
// keeps the download pinned to the official URL above.
function installerEnv() {
  const env = {};
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

function installPrimeAgentSync() {
  try {
    process.stderr.write(
      `[bb-plugin-prime-agent-acp] Downloading and installing the official prime-agent binary from ${INSTALL_URL}\n`,
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

// A conservative model id pattern: anything that could smuggle flag syntax
// (spaces, `--`, quotes, shell metacharacters) is rejected instead of being
// forwarded as `--model <value>`.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@%+/-]*$/;

const argv = process.argv.slice(2);

// Direct install command — explicit, confirmed, prints the URL first.
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

// Model listing is read-only: no auto-install here either.
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

// Normal launch in ACP mode — requires an already-installed binary.
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

// Ensure --mode acp is present
if (!rest.includes("--mode")) {
  rest.push("--mode", "acp");
}

const childArgs = [
  ...rest,
  ...(provider ? ["--provider", provider] : []),
  ...(modelId ? ["--model", modelId] : []),
  ...(thinking ? ["--thinking", thinking] : []),
];

const r = spawnSync(bin, childArgs, { stdio: "inherit" });
process.exit(r.status ?? 0);
