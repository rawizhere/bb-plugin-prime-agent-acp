# bb-plugin-prime-agent-acp

Run bb threads on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) through its native Agent Client Protocol (ACP) server.

## Features

- **Native ACP Provider:** Registers provider `acp-prime-agent` in bb IDE with branding and icons.
- **Model Catalog & Reasoning:** Supports dynamic model discovery (`--list-models`), reasoning levels (`--thinking`), and model routing across OpenCode, OpenRouter, and custom providers.
- **CLI Commands:** `bb prime-agent status` and `bb prime-agent models` for diagnostics.
- **Standalone:** Self-contained launcher locating `prime-agent` binary automatically.

## Installation

### Local Install (Path)

```bash
bb plugin install /path/to/bb-plugin-prime-agent-acp --yes
```

### Build from source

```bash
npm install
bb plugin build
```

## CLI Usage

```bash
# Check provider and launcher status
bb prime-agent status

# List discovered models
bb prime-agent models
```
