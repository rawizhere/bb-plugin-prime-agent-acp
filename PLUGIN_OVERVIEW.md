Run bb threads on Prime Agent (Prime Intellect's agent) through its native
Agent Client Protocol server. The plugin renders Prime Agent surfaces
natively in bb.

## What you get

- An `acp-prime-agent` provider in the bb model picker, backed by your
  locally installed `prime-agent` binary.
- RLM subagents spawned by Prime Agent inside a turn appear as delegation
  items in the thread timeline: the child's session name, its model, and a
  live token count while it runs.
- The plugin stores goal state (objective, status, token budget, tokens used)
  as thread state, and goal transitions appear as timeline items.
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
- Prime Agent routes model traffic to the providers you configure in it
  (OpenCode Zen, OpenRouter, or a custom provider). You supply the API keys.

## CLI

- `bb prime-agent status` prints launcher and resolved binary status.
- `bb prime-agent models` lists the models Prime Agent discovers.
- `bb prime-agent install --yes` installs the official binary.
