#!/usr/bin/env node
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function findPrimeAgentBinary() {
  const candidates = [
    process.env.PRIME_AGENT_BIN,
    "/opt/homebrew/bin/prime-agent",
    "/usr/local/bin/prime-agent",
    "/usr/bin/prime-agent",
    path.join(homedir(), ".local/bin/prime-agent"),
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

const argv = process.argv.slice(2);

// If asked to list models:
if (argv.includes("--list-models") || (argv[0] === "model" && argv[1] === "list")) {
  const bin = findPrimeAgentBinary();
  if (!bin) {
    console.error("prime-agent binary not found");
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
  for (const line of text.split("\n")) {
    if (/^\s*provider\s+model/i.test(line) || line.startsWith("-")) continue;
    const cols = line.trim().split(/\s+/);
    const provider = cols[0];
    const id = cols[1];
    if (!provider || !id) continue;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const isFree = id.toLowerCase().includes("free");
    const tag = isFree ? " · FREE" : "";
    console.log(`${key} - ${id}${tag} (${provider})`);
  }
  process.exit(0);
}

// Normal launch in ACP mode:
const bin = findPrimeAgentBinary();
if (!bin) {
  console.error("prime-agent binary not found");
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
