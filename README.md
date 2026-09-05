# Prime Agent (ACP) for bb

Run bb threads on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (by Prime Intellect) through its native Agent Client Protocol (ACP) server.

## Features

- **Native ACP Provider:** Registers provider `acp-prime-agent` in bb IDE with official branding and theme support.
- **Explicit Installation:** Prime Agent is never installed implicitly. First run never downloads anything — you install the binary once with `bb prime-agent install --yes`, which downloads and runs Prime Intellect's official installer script.
- **Model Catalog & Reasoning:** Dynamic model discovery (`prime-agent model list`), reasoning levels (`--thinking`), and model routing across OpenCode Zen, OpenRouter, and custom providers.
- **Prime Agent surfaces in bb:** RLM subagents render as delegation items (name, model, live token count); goals, harness refinements, compaction, and agent-to-agent messages surface as thread state / timeline items via the plugin's ACP dialect (see `dialect/prime-agent-dialect.js`).
- **Vendored bridge:** the SDK's `provider-bridge-acp.js` is vendored under `vendor/` with the dialect injected by `scripts/apply-dialect.py`, so rebuilds always carry it. After an SDK bump re-vendor:

  ```bash
  npm install @get-bb/plugin-sdk@<version>
  cp node_modules/@get-bb/plugin-sdk/dist/provider-bridge-acp.js vendor/
  python3 scripts/apply-dialect.py
  python3 scripts/apply-dialect.py --check
  ```

  `--check` fails loudly when the vendored file drifts from a fresh apply (e.g. the SDK layout changed and the script's anchors no longer match).
- **CLI Commands:**
  - `bb prime-agent status` — Inspect provider, launcher, and resolved binary status.
  - `bb prime-agent models` — List discovered models with free model annotations.
  - `bb prime-agent install --yes` — Download and install the official `prime-agent` binary.

## What the plugin runs

- Selecting the Prime Agent provider launches the locally installed `prime-agent` binary in ACP mode.
- Thread content is processed by Prime Intellect's Prime Agent (the vendor behind
  [app.primeintellect.ai](https://app.primeintellect.ai)); model traffic goes to the
  providers you configure (OpenCode Zen, OpenRouter, or a custom provider).
- The plugin itself makes no network calls from its own code. The only download is
  the explicit `bb prime-agent install --yes` command, which fetches
  <https://app.primeintellect.ai/prime-agent/install.sh> and runs it in a minimal
  environment (PATH and HOME only — no daemon secrets are passed to the script).

## Installation

### From a release tag

```bash
bb plugin install git:https://github.com/rawizhere/bb-plugin-prime-agent-acp.git@^0.1.8
```

### From Git

```bash
bb plugin install git:https://github.com/rawizhere/bb-plugin-prime-agent-acp.git
```

### Local Development

```bash
git clone https://github.com/rawizhere/bb-plugin-prime-agent-acp.git
cd bb-plugin-prime-agent-acp
npm install
bb plugin build
bb plugin install . --yes
```

## CLI Usage

```bash
# Check provider status
bb prime-agent status

# Install or update the prime-agent binary (explicit download, requires --yes)
bb prime-agent install --yes

# List available models
bb prime-agent models


```


## Troubleshooting

### `403 Key limit exceeded` (OpenRouter)

This error comes from OpenRouter, not the plugin: your OpenRouter key hit its total usage limit. Replace the key or fund the workspace:

- Edit `~/.prime/agent/auth.json` → `"openrouter"` → `"key"` govern new value, or
- set `OPENROUTER_API_KEY` in the environment bb starts from, or
- run `prime-agent` on this machine and `/login` → OpenRouter.

### `No API key found for openrouter` (right after a `403`)

The key usually is still in `~/.prime/agent/auth.json`, but Prime Agent marks that exact key as stale in a long-running daemon after an auth failure, so later turns report it as missing. Fixes:

- Replace the key with a **different value** (the stale mark is tied to the old value, so a new value clears it immediately), or
- start a fresh bb thread (a fresh daemon has no stale mark), or
- pick a free non-OpenRouter model like `opencode/hy3-free` in the bb model picker.



Check current credential state in `~/.prime/agent/auth.json`, or by running `prime-agent` directly and using `/login`.
