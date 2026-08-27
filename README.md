# Prime Agent (ACP) for bb

Run bb threads on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) (by Prime Intellect) through its native Agent Client Protocol (ACP) server.

## Features

- **Native ACP Provider:** Registers provider `acp-prime-agent` in bb IDE with official branding and theme support.
- **Zero-Config Auto Provisioning:** If `prime-agent` is not installed on the system, the launcher automatically downloads and sets up the official release binary upon first run.
- **Model Catalog & Reasoning:** Supports dynamic model discovery (`--list-models`), reasoning levels (`--thinking`), and model routing across OpenCode Zen, OpenRouter, and custom providers.
- **CLI Commands:**
  - `bb prime-agent status` — Inspect provider, launcher, and resolved binary status.
  - `bb prime-agent models` — List discovered models with free model annotations.
  - `bb prime-agent install` — One-step download and install of official `prime-agent` binary.

## Installation

### From Marketplace (once merged)

```bash
bb plugin install prime-agent-acp
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

# Install or update the prime-agent binary
bb prime-agent install

# List available models
bb prime-agent models
```
