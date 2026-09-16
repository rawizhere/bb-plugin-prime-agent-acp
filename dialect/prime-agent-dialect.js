// ============================================================================
// prime-agent ACP dialect (injected into the provider bridge host bundle).
//
// prime-agent publishes first-class agent concepts that ACP v1 has no update
// kind for (RLM subagents, compaction, goals, harness refinement, agent-to-agent
// messages) as namespaced `_meta` on `session_info_update`:
//
//   _meta["ai.primeintellect.prime-agent"] = {
//     subagents?:  [{ id, sessionName, status, model, tokenCount, error }],
//     compaction?: { tokensBefore, summary },
//     goal?:       { status, objective, tokenBudget, tokensUsed },
//     refinement?: { status: "complete"|"failed", summary?, changes?, error? },
//     agentMessage?: { toolCallId, target, deliveryStatus },
//     autonomous?: { enabled, continuationsUsed, turnsUsed, tokensUsed, gateAttempt?, gateFailure?, limitReason? },
//     quiescence?: { outstandingSubagents, remainingAutonomousContinuations },
//     cwd?: { requested, actual },
//     heartbeatsChanged?: boolean,
//   }
//
// (see prime-agent dist/modes/acp/acp-events.js; namespace from acp-meta.js)
//
// The dialect maps them onto bb deltas:
//   subagents    -> delegation items (like the grok dialect's spawn_subagent)
//   compaction   -> context.compacted
//   goal         -> extension.state "provider-codex/goal" (the app's goal UI
//                   reads exactly this kind; native goal delta is an upstream
//                   bb conversation)
//   refinement   -> extension item "prime-agent-acp/refinement"
//   agentMessage -> extension item "prime-agent-acp/agent-message"
//   autonomous   -> extension.state "prime-agent-acp/autonomous" plus an item
//                   whenever the counters or gate state change
//   quiescence   -> remainingAutonomousContinuations folds into the autonomous
//                   payload; outstandingSubagents is 0 wherever prime-agent
//                   publishes it because settlement waits for children
//   cwd          -> session/new response meta stashed per thread, flushed as a
//                   one-shot "prime-agent-acp/cwd" item on the first in-turn
//                   session info update
//   heartbeatsChanged -> no-op, bb has no provider-agnostic heartbeat surface
//
// Intentionally ignored prime-agent meta fields (no bb surface, no action):
//   terminalQuiescenceExpected: transient prompt-boundary marker tied to
//                   turn settlement; the completion update already puts the
//                   quiescence counters into the autonomous payload.
//   heartbeatsChanged: see above.
//
// `sessionInfo(update)` returns plain-data actions; the bridge's
// session_info_update case (PRIME_AGENT_ACP_DIALECT_V2) turns them into deltas
// using translator-internal helpers. Kept dependency-free on purpose.
// ============================================================================

var PRIME_AGENT_META_NAMESPACE = "ai.primeintellect.prime-agent";
// The app's native goal banner reads ONLY the "provider-codex/goal" kind, and
// the ingest validator enforces that a provider may only emit kinds owned by
// the plugin that registered it (extensionOwnershipProblem). So the native
// banner is unreachable for this plugin by design; we emit our own kind (the
// state is stored thread-scoped, latest-wins) plus visible transition items.
// A generalized goal kind is an upstream bb conversation.
var PRIME_AGENT_GOAL_EXTENSION_KIND = "prime-agent-acp/goal";
var PRIME_AGENT_SUBAGENT_CHILD_REF_PREFIX = "prime-agent:";
var PRIME_AGENT_SUBAGENT_ITEM_KEY_PREFIX = "prime-agent-subagent-";
var PRIME_AGENT_REFINEMENT_EXTENSION_KIND = "prime-agent-acp/refinement";
var PRIME_AGENT_AGENT_MESSAGE_EXTENSION_KIND = "prime-agent-acp/agent-message";
var PRIME_AGENT_AUTONOMOUS_EXTENSION_KIND = "prime-agent-acp/autonomous";
var PRIME_AGENT_CWD_EXTENSION_KIND = "prime-agent-acp/cwd";

function primeAgentIsRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

var primeAgentGoalStatusByThread = /* @__PURE__ */ new Map();

// Delegation lifecycle dedupe (per thread): prime-agent re-sends the full
// subagent list on every session_info_update, so without dedupe each tick
// re-emits an item.open delta for every running child (event noise in the
// thread history) and re-closes already-settled children (falls back to
// provider/unhandled outside an open turn). An already-open child is only
// re-opened when its presentation detail (model / token count) changed, so
// live token ticking still updates the card.
var primeAgentDelegationStateByThread = /* @__PURE__ */ new Map();

// Autonomous continuation state, last emitted signature per thread: prime-agent
// re-sends the autonomous meta on every turn-end and terminal envelope, so the
// item only re-emits when the counters or gate state actually change.
var primeAgentAutonomousStateByThread = /* @__PURE__ */ new Map();

// cwd mismatches arrive on the session/new response, before any turn exists to
// attach an item to. Stash and flush on the first session info update that
// carries real turn content, which is the turn-end completion update.
var primeAgentPendingCwdByThread = /* @__PURE__ */ new Map();

function primeAgentDelegationPhase(threadId, childId, isOpening, detail) {
  let byId = primeAgentDelegationStateByThread.get(threadId);
  if (byId === void 0) {
    byId = /* @__PURE__ */ new Map();
    primeAgentDelegationStateByThread.set(threadId, byId);
  }
  const state = byId.get(childId);
  if (isOpening) {
    if (state === void 0) {
      byId.set(childId, { phase: "open", detail });
      return "open";
    }
    if (state.phase === "open" && state.detail !== detail) {
      state.detail = detail;
      return "open";
    }
    return void 0;
  }
  if (state === void 0) {
    byId.set(childId, { phase: "closed", detail });
    return "close";
  }
  if (state.phase !== "open") {
    return void 0;
  }
  state.phase = "closed";
  state.detail = detail;
  return "close";
}

function primeAgentGoalTransition(previous, next) {
  if (previous === next) {
    return void 0;
  }
  if (next === "active") {
    return previous === void 0 || previous === "idle" ? "started" : "resumed";
  }
  if (next === "complete") {
    return "completed";
  }
  if (next === "paused") {
    return "paused";
  }
  if (next === "budget_limited") {
    return "budget_limited";
  }
  if (next === "error") {
    return "error";
  }
  return void 0;
}

function primeAgentCompactTokens(tokens) {
  if (tokens < 1000) {
    return `${tokens} tok`;
  }
  return `${Math.round(tokens / 100) / 10}k tok`;
}

function primeAgentSessionNew(meta, context) {
  const namespaced = primeAgentIsRecord(meta) ? meta[PRIME_AGENT_META_NAMESPACE] : void 0;
  const cwd = primeAgentIsRecord(namespaced) ? namespaced.cwd : void 0;
  const threadId = primeAgentIsRecord(context) && typeof context.threadId === "string" ? context.threadId : "";
  if (!primeAgentIsRecord(cwd) || threadId.length === 0) {
    return void 0;
  }
  if (typeof cwd.requested !== "string" || cwd.requested.length === 0 || typeof cwd.actual !== "string" || cwd.actual.length === 0) {
    return void 0;
  }
  primeAgentPendingCwdByThread.set(threadId, { requested: cwd.requested, actual: cwd.actual });
  return void 0;
}

function primeAgentSessionInfoActions(update, context) {
  const meta = primeAgentIsRecord(update) ? update._meta : void 0;
  const namespaced = primeAgentIsRecord(meta) ? meta[PRIME_AGENT_META_NAMESPACE] : void 0;
  if (!primeAgentIsRecord(namespaced)) {
    return void 0;
  }
  const actions = [];
  const threadId = primeAgentIsRecord(context) && typeof context.threadId === "string" ? context.threadId : "";
  const hasTurnContent = namespaced.subagents !== void 0 || namespaced.compaction !== void 0 || namespaced.goal !== void 0 || namespaced.refinement !== void 0 || namespaced.agentMessage !== void 0 || namespaced.autonomous !== void 0 || namespaced.quiescence !== void 0;
  const pendingCwd = threadId.length > 0 ? primeAgentPendingCwdByThread.get(threadId) : void 0;
  if (pendingCwd && hasTurnContent) {
    primeAgentPendingCwdByThread.delete(threadId);
    actions.push({
      op: "info",
      key: `prime-agent-cwd-${threadId}`,
      kind: PRIME_AGENT_CWD_EXTENSION_KIND,
      status: "completed",
      pendingLabel: "Checking working directory",
      completedLabel: "Working directory mismatch",
      icon: "TriangleAlert",
      title: `requested ${pendingCwd.requested}`,
      detail: `agent runs in ${pendingCwd.actual}`,
      payload: { requested: pendingCwd.requested, actual: pendingCwd.actual }
    });
  }
  if (Array.isArray(namespaced.subagents)) {
    for (const child of namespaced.subagents) {
      if (!primeAgentIsRecord(child) || typeof child.id !== "string" || child.id.length === 0) {
        continue;
      }
      const label = typeof child.sessionName === "string" && child.sessionName.length > 0 ? child.sessionName : child.id;
      const detailParts = [];
      if (typeof child.model === "string" && child.model.length > 0) {
        detailParts.push(child.model);
      }
      if (typeof child.tokenCount === "number" && Number.isFinite(child.tokenCount) && child.tokenCount > 0) {
        detailParts.push(`${child.tokenCount} tok`);
      }
      const detail = detailParts.length > 0 ? detailParts.join(" · ") : void 0;
      const summary = typeof child.error === "string" && child.error.length > 0 ? child.error : detail;
      switch (child.status) {
        case "queued":
        case "pending":
        case "running": {
          const phase = primeAgentDelegationPhase(threadId, child.id, true, detail);
          if (phase !== void 0) {
            actions.push({ op: "delegate", phase, id: child.id, label, detail });
          }
          break;
        }
        case "done":
        case "completed": {
          const phase = primeAgentDelegationPhase(threadId, child.id, false, detail);
          if (phase !== void 0) {
            actions.push({ op: "delegate", phase, id: child.id, label, detail, closeStatus: "completed", summary });
          }
          break;
        }
        case "error": {
          const phase = primeAgentDelegationPhase(threadId, child.id, false, detail);
          if (phase !== void 0) {
            actions.push({ op: "delegate", phase, id: child.id, label, detail, closeStatus: "failed", summary });
          }
          break;
        }
        case "cancelled": {
          const phase = primeAgentDelegationPhase(threadId, child.id, false, detail);
          if (phase !== void 0) {
            actions.push({ op: "delegate", phase, id: child.id, label, detail, closeStatus: "interrupted", summary });
          }
          break;
        }
      }
    }
  }
  if (primeAgentIsRecord(namespaced.compaction)) {
    actions.push({ op: "compacted" });
  }
  if (primeAgentIsRecord(namespaced.goal)) {
    const goal = namespaced.goal;
    const cleared = goal.status === "idle" || typeof goal.objective !== "string" || goal.objective.length === 0;
    const tokensUsed = typeof goal.tokensUsed === "number" ? Math.max(0, Math.trunc(goal.tokensUsed)) : 0;
    const tokenBudget = typeof goal.tokenBudget === "number" ? goal.tokenBudget : null;
    const timeUsedSeconds = typeof goal.timeUsedSeconds === "number" ? Math.max(0, Math.trunc(goal.timeUsedSeconds)) : 0;
    actions.push({
      op: "goalState",
      payload: cleared ? null : {
        objective: goal.objective,
        status: goal.status === "paused" ? "paused" : goal.status === "budget_limited" ? "budgetLimited" : goal.status === "complete" ? "complete" : goal.status === "error" ? "paused" : "active",
        tokenBudget,
        tokensUsed,
        timeUsedSeconds
      }
    });
    if (!cleared) {
      const previous = primeAgentGoalStatusByThread.get(threadId);
      const transition = primeAgentGoalTransition(previous, goal.status);
      primeAgentGoalStatusByThread.set(threadId, goal.status);
      if (transition !== void 0) {
        const goalTitles = {
          started: "Goal started",
          resumed: "Goal resumed",
          completed: "Goal completed",
          paused: "Goal paused",
          budget_limited: "Goal budget reached",
          error: "Goal error"
        };
        const goalDetails = {
          started: tokenBudget === null ? void 0 : `budget ${tokenBudget} tok`,
          resumed: void 0,
          completed: `${tokensUsed} tok`,
          paused: void 0,
          budget_limited: `${tokensUsed} tok`,
          error: void 0
        };
        actions.push({
          op: "info",
          key: `prime-agent-goal-${threadId}`,
          kind: PRIME_AGENT_GOAL_EXTENSION_KIND,
          status: transition === "error" ? "failed" : "completed",
          pendingLabel: "Goal active",
          completedLabel: goalTitles[transition] ?? "Goal updated",
          icon: "Target",
          title: goal.objective,
          detail: goalDetails[transition],
          payload: {
            transition,
            objective: goal.objective,
            status: goal.status,
            tokenBudget,
            tokensUsed,
            timeUsedSeconds
          }
        });
      }
    } else {
      primeAgentGoalStatusByThread.delete(threadId);
    }
  }
  if (primeAgentIsRecord(namespaced.autonomous) && namespaced.autonomous.enabled !== false) {
    const autonomous = namespaced.autonomous;
    const continuationsUsed = typeof autonomous.continuationsUsed === "number" && Number.isFinite(autonomous.continuationsUsed) ? Math.max(0, Math.trunc(autonomous.continuationsUsed)) : 0;
    const turnsUsed = typeof autonomous.turnsUsed === "number" && Number.isFinite(autonomous.turnsUsed) ? Math.max(0, Math.trunc(autonomous.turnsUsed)) : 0;
    const tokensUsed = typeof autonomous.tokensUsed === "number" && Number.isFinite(autonomous.tokensUsed) ? Math.max(0, Math.trunc(autonomous.tokensUsed)) : 0;
    const quiescence = primeAgentIsRecord(namespaced.quiescence) ? namespaced.quiescence : void 0;
    const remainingContinuations = quiescence !== void 0 && typeof quiescence.remainingAutonomousContinuations === "number" && Number.isFinite(quiescence.remainingAutonomousContinuations) ? Math.max(0, Math.trunc(quiescence.remainingAutonomousContinuations)) : void 0;
    const gateFailure = typeof autonomous.gateFailure === "string" && autonomous.gateFailure.length > 0 ? autonomous.gateFailure : void 0;
    const limitReason = typeof autonomous.limitReason === "string" && autonomous.limitReason.length > 0 ? autonomous.limitReason : void 0;
    const payload = {
      enabled: true,
      continuationsUsed,
      turnsUsed,
      tokensUsed,
      ...(remainingContinuations !== void 0 ? { remainingContinuations } : {}),
      ...(gateFailure !== void 0 ? { gateFailure } : {}),
      ...(limitReason !== void 0 ? { limitReason } : {})
    };
    actions.push({ op: "autonomousState", payload });
    const signature = JSON.stringify(payload);
    if (primeAgentAutonomousStateByThread.get(threadId) !== signature) {
      primeAgentAutonomousStateByThread.set(threadId, signature);
      const counts = remainingContinuations === void 0 ? `${continuationsUsed} continuations` : `${continuationsUsed} of ${continuationsUsed + remainingContinuations} continuations`;
      const failed = gateFailure !== void 0 || limitReason !== void 0;
      actions.push({
        op: "info",
        key: `prime-agent-autonomous-${threadId}`,
        kind: PRIME_AGENT_AUTONOMOUS_EXTENSION_KIND,
        status: failed ? "failed" : "completed",
        pendingLabel: "Autonomous continuations",
        completedLabel: gateFailure !== void 0 ? "Autonomous gate failed" : limitReason !== void 0 ? "Autonomous limit reached" : "Autonomous continuations",
        icon: failed ? "CircleAlert" : "Repeat",
        title: void 0,
        detail: gateFailure ?? limitReason ?? `${counts} · ${primeAgentCompactTokens(tokensUsed)}`,
        payload
      });
    }
  }
  if (primeAgentIsRecord(namespaced.refinement)) {
    const refinement = namespaced.refinement;
    const failed = refinement.status === "failed";
    const changes = Array.isArray(refinement.changes) ? refinement.changes.filter((change) => typeof change === "string") : [];
    const summaryParts = [];
    if (typeof refinement.summary === "string" && refinement.summary.length > 0) {
      summaryParts.push(refinement.summary);
    }
    if (changes.length > 0) {
      summaryParts.push(changes.join(", "));
    }
    const summary = summaryParts.join(" \u2014 ");
    actions.push({
      op: "info",
      key: "prime-agent-refinement",
      kind: PRIME_AGENT_REFINEMENT_EXTENSION_KIND,
      status: failed ? "failed" : "completed",
      pendingLabel: failed ? "Harness refinement failed" : "Refining harness",
      completedLabel: failed ? "Harness refinement failed" : "Refined harness",
      icon: failed ? "CircleAlert" : "Wrench",
      title: summary.length > 0 ? summary : void 0,
      detail: failed && typeof refinement.error === "string" && refinement.error.length > 0 ? refinement.error : void 0,
      payload: {
        status: failed ? "failed" : "complete",
        ...(summary.length > 0 ? { summary } : {}),
        ...(changes.length > 0 ? { changes } : {}),
        ...(failed && typeof refinement.error === "string" ? { error: refinement.error } : {})
      }
    });
  }
  if (primeAgentIsRecord(namespaced.agentMessage)) {
    const message = namespaced.agentMessage;
    const failedDelivery = message.deliveryStatus === "failed";
    actions.push({
      op: "info",
      key: `prime-agent-agent-message-${typeof message.toolCallId === "string" && message.toolCallId.length > 0 ? message.toolCallId : "unknown"}`,
      kind: PRIME_AGENT_AGENT_MESSAGE_EXTENSION_KIND,
      status: failedDelivery ? "failed" : "completed",
      pendingLabel: "Agent message",
      completedLabel: "Agent message",
      icon: "Send",
      title: typeof message.target === "string" ? `to ${message.target}` : void 0,
      detail: typeof message.target === "string" ? message.target : void 0,
      payload: {
        ...(typeof message.target === "string" ? { target: message.target } : {}),
        ...(typeof message.deliveryStatus === "string" ? { deliveryStatus: message.deliveryStatus } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {})
      }
    });
  }
  return actions;
}

// Python REPL rich output: prime-agent reports kernel attachments (mimeType,
// optional on-disk path, decoded byte length) and applied-diff counts as
// namespaced `_meta` on the ipython tool_call_update. ACP has no rich-output
// channel for tool results, so surface them as readable lines appended to the
// cell's aggregated output in bb (full image rendering would need an
// imageView-capable dialect hook, which the SDK bridge does not offer yet).
function primeAgentFormatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  for (const unit of units) {
    value /= 1024;
    if (value < 1024 || unit === units[units.length - 1]) {
      return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${unit}`;
    }
  }
  return `${bytes} B`;
}

// The bridge merges tool_call + tool_call_update into one event via explicit
// fields only (mergeAcpToolCallEvents drops _meta), so capture the rich output
// meta from each raw update via the toolIdentity hook (called before the merge)
// and look it up by toolCallId when the bridge closes the command item.
var primeAgentIpythonMetaByToolCall = /* @__PURE__ */ new Map();

function primeAgentIpythonMeta(event) {
  const fromMap = typeof event?.toolCallId === "string" ? primeAgentIpythonMetaByToolCall.get(event.toolCallId) : void 0;
  if (primeAgentIsRecord(fromMap)) {
    return fromMap;
  }
  const meta = primeAgentIsRecord(event) ? event._meta : void 0;
  const namespaced = primeAgentIsRecord(meta) ? meta[PRIME_AGENT_META_NAMESPACE] : void 0;
  return primeAgentIsRecord(namespaced) ? namespaced.ipython : void 0;
}

function primeAgentToolIdentity(event) {
  const meta = primeAgentIsRecord(event) ? event._meta : void 0;
  const namespaced = primeAgentIsRecord(meta) ? meta[PRIME_AGENT_META_NAMESPACE] : void 0;
  const rich = primeAgentIsRecord(namespaced) ? namespaced.ipython : void 0;
  if (!primeAgentIsRecord(rich) || typeof event.toolCallId !== "string") {
    return void 0;
  }
  primeAgentIpythonMetaByToolCall.set(event.toolCallId, rich);
  return void 0;
}

function primeAgentCommandResult(event) {
  const rich = primeAgentIpythonMeta(event);
  if (!primeAgentIsRecord(rich)) {
    return void 0;
  }
  if (typeof event?.toolCallId === "string") {
    primeAgentIpythonMetaByToolCall.delete(event.toolCallId);
  }
  const attachments = Array.isArray(rich.attachments) ? rich.attachments.filter(primeAgentIsRecord) : [];
  const notes = [];
  for (const attachment of attachments) {
    const mime = typeof attachment.mimeType === "string" && attachment.mimeType.length > 0 ? attachment.mimeType : "file";
    const size = typeof attachment.bytes === "number" && Number.isFinite(attachment.bytes) && attachment.bytes > 0 ? `, ${primeAgentFormatBytes(attachment.bytes)}` : "";
    notes.push(
      typeof attachment.path === "string" && attachment.path.length > 0 ? `attachment ${attachment.path} (${mime}${size})` : `attachment (${mime}${size})`
    );
  }
  if (typeof rich.diffCount === "number" && Number.isFinite(rich.diffCount) && rich.diffCount > 0) {
    notes.push(`${rich.diffCount} ${rich.diffCount === 1 ? "diff" : "diffs"} applied to source`);
  }
  if (notes.length === 0) {
    return void 0;
  }
  const base = extractAcpCommandResult(event);
  const body = typeof base.output === "string" && base.output.length > 0 ? `${base.output}\n\n` : "";
  return { ...base, output: `${body}${notes.join("\n")}` };
}

var PRIME_AGENT_ACP_DIALECT = {
  id: "prime-agent",
  sessionNew: primeAgentSessionNew,
  sessionInfo: primeAgentSessionInfoActions,
  toolIdentity: primeAgentToolIdentity,
  commandResult: primeAgentCommandResult
};
