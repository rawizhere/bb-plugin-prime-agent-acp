Run bb threads on Prime Agent (Prime Intellect's agent) through its native
Agent Client Protocol server, with Prime Agent-specific surfaces rendered
natively in bb.

## What you get

- A first-class `acp-prime-agent` provider in the bb model picker, backed by
  your locally installed `prime-agent` binary.
- RLM subagents spawned by Prime Agent inside a turn appear as delegation
  items in the thread timeline: the child's session name, its model, and a
  live token count while it runs.
- Goal state (objective, status, token budget, tokens used) is stored as
  thread state and goal transitions appear as timeline items.
- Harness refinements, context compaction, and agent-to-agent message
  deliveries surface as timeline items instead of being dropped.

## How it works

The plugin registers the provider and launches `prime-agent --mode acp` via a
stable PATH-based launcher, so threads work on any machine where the binary is
installed. A vendored copy of the bb ACP provider bridge adds a Prime Agent
dialect: Prime Agent publishes subagents, goals, refinements, compaction, and
agent messages as namespaced ACP metadata, and the dialect maps them onto bb's
timeline deltas. See `dialect/prime-agent-dialect.js` and
`vendor/provider-bridge-acp.js`.

## Requirements

- [bb](https://getbb.app) 0.42 or newer.
- The [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent) binary,
  installed once with `bb prime-agent install --yes` (this downloads and runs
  Prime Intellect's official installer; the plugin itself makes no network
  calls from its own code).
- Model traffic and API keys are yours: Prime Agent routes to the providers
  you configure in it (OpenCode Zen, OpenRouter, custom providers).

## CLI

- `bb prime-agent status` — launcher and resolved binary status.
- `bb prime-agent models` — models discovered by Prime Agent.
- `bb prime-agent install --yes` — install the official binary.
