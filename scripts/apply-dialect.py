#!/usr/bin/env python3
"""Apply the prime-agent ACP dialect to the vendored provider bridge.

The plugin vendors @get-bb/plugin-sdk's provider-bridge-acp (vendored/
provider-bridge-acp.js, copied from node_modules) because bb does not expose
a dialect registry yet: a provider plugin can only pick one of the shipped
dialects (generic/cursor/grok). We inject dialect/prime-agent-dialect.js into
the vendored copy so every `bb plugin build`/reload rebuild includes it
natively -- no post-build patching.

Usage:
    python3 scripts/apply-dialect.py          # apply to vendor/provider-bridge-acp.js
    python3 scripts/apply-dialect.py --check  # verify vendor/ matches a fresh apply

Re-vendor after an SDK bump:
    npm install @get-bb/plugin-sdk@<version>
    cp node_modules/@get-bb/plugin-sdk/dist/provider-bridge-acp.js vendor/
    python3 scripts/apply-dialect.py

The script fails loudly when its anchors no longer match the SDK layout --
never hand-edit vendor/provider-bridge-acp.js.
"""
import datetime
import json
import subprocess
import sys
import tempfile
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDORED = ROOT / "vendor" / "provider-bridge-acp.js"
DIALECT = ROOT / "dialect" / "prime-agent-dialect.js"

V3_MARKER = "PRIME_AGENT_ACP_DIALECT_V3"

DIALECT_MAP_BLOCK = """var DIALECTS_BY_ID = /* @__PURE__ */ new Map([
  [CURSOR_ACP_DIALECT.id, CURSOR_ACP_DIALECT],
  [GROK_ACP_DIALECT.id, GROK_ACP_DIALECT],
  [OMP_ACP_DIALECT.id, OMP_ACP_DIALECT],
  [OPENCODE_ACP_DIALECT.id, OPENCODE_ACP_DIALECT]
]);
var DIALECT_IDS_BY_COMMAND = {
  "cursor-agent": CURSOR_ACP_DIALECT.id,
  grok: GROK_ACP_DIALECT.id,
  omp: OMP_ACP_DIALECT.id,
  opencode: OPENCODE_ACP_DIALECT.id
};"""

DIALECT_MAP_BLOCK_REPLACED = """__DIALECT_SOURCE__

var DIALECTS_BY_ID = /* @__PURE__ */ new Map([
  [CURSOR_ACP_DIALECT.id, CURSOR_ACP_DIALECT],
  [GROK_ACP_DIALECT.id, GROK_ACP_DIALECT],
  [OMP_ACP_DIALECT.id, OMP_ACP_DIALECT],
  [OPENCODE_ACP_DIALECT.id, OPENCODE_ACP_DIALECT],
  [PRIME_AGENT_ACP_DIALECT.id, PRIME_AGENT_ACP_DIALECT]
]);
var DIALECT_IDS_BY_COMMAND = {
  "cursor-agent": CURSOR_ACP_DIALECT.id,
  grok: GROK_ACP_DIALECT.id,
  omp: OMP_ACP_DIALECT.id,
  opencode: OPENCODE_ACP_DIALECT.id,
  "prime-agent": PRIME_AGENT_ACP_DIALECT.id,
  "prime-agent-acp-launch": PRIME_AGENT_ACP_DIALECT.id,
  "bb-prime-launch.mjs": PRIME_AGENT_ACP_DIALECT.id
};"""

DEFAULT_BLOCK = """      default:
        return unhandledDeltas(rawEvent);"""

SESSION_INFO_CASE = """      case "session_info_update": {
        // PRIME_AGENT_ACP_DIALECT_V3: dialect-driven session info translation.
        // The dialect returns plain-data actions; this case maps them to deltas
        // with translator-internal helpers (streams, turn fallback).
        // A session_info_update without prime-agent meta is intentionally
        // ignored (plain ACP session info): return no deltas instead of
        // suppressedUnhandled so no provider/unhandled debug event persists.
        const sessionInfoActions = dialect.sessionInfo?.(update, context);
        if (sessionInfoActions === void 0) {
          return [];
        }
        if (sessionInfoActions.length === 0) {
          return [];
        }
        const sessionInfoDeltas = [closeThoughtStream(), closeAssistantStream()];
        for (const sessionInfoAction of sessionInfoActions) {
          if (sessionInfoAction.op === "delegate") {
            const sessionInfoItemKey = `${PRIME_AGENT_SUBAGENT_ITEM_KEY_PREFIX}${sessionInfoAction.id}`;
            const delegateItem = {
              type: "delegation",
              childRef: `${PRIME_AGENT_SUBAGENT_CHILD_REF_PREFIX}${sessionInfoAction.id}`,
              label: sessionInfoAction.label,
              background: false,
              ...(sessionInfoAction.summary === void 0 ? {} : { summary: sessionInfoAction.summary })
            };
            const delegatePresentation = delegationPresentation({
              label: sessionInfoAction.label,
              ...(sessionInfoAction.detail === void 0 ? {} : { detail: sessionInfoAction.detail })
            });
            sessionInfoDeltas.push(
              sessionInfoAction.phase === "open" ? {
                kind: "item.open",
                key: { providerItemId: sessionInfoItemKey },
                item: delegateItem,
                presentation: delegatePresentation,
                noTurnFallback: noTurnFallbackFor(rawEvent)
              } : {
                kind: "item.close",
                key: { providerItemId: sessionInfoItemKey },
                status: sessionInfoAction.closeStatus,
                item: delegateItem,
                presentation: delegatePresentation,
                noTurnFallback: noTurnFallbackFor(rawEvent)
              }
            );
          } else if (sessionInfoAction.op === "compacted") {
            sessionInfoDeltas.push({
              kind: "context.compacted",
              noTurnFallback: noTurnFallbackFor(rawEvent)
            });
          } else if (sessionInfoAction.op === "goalState") {
            sessionInfoDeltas.push({
              kind: "extension.state",
              extensionKind: PRIME_AGENT_GOAL_EXTENSION_KIND,
              payload: sessionInfoAction.payload
            });
          } else if (sessionInfoAction.op === "autonomousState") {
            sessionInfoDeltas.push({
              kind: "extension.state",
              extensionKind: PRIME_AGENT_AUTONOMOUS_EXTENSION_KIND,
              payload: sessionInfoAction.payload
            });
          } else if (sessionInfoAction.op === "info") {
            const infoPresentation = {
              label: { pending: sessionInfoAction.pendingLabel, completed: sessionInfoAction.completedLabel },
              icon: { glyph: sessionInfoAction.icon },
              ...(sessionInfoAction.title === void 0 ? {} : { title: presentationTitle(sessionInfoAction.title) }),
              ...(sessionInfoAction.detail === void 0 ? {} : { detail: sessionInfoAction.detail })
            };
            sessionInfoDeltas.push({
              kind: "item.close",
              key: { providerItemId: sessionInfoAction.key },
              status: sessionInfoAction.status,
              item: { type: "extension", kind: sessionInfoAction.kind, payload: sessionInfoAction.payload },
              presentation: infoPresentation,
              noTurnFallback: noTurnFallbackFor(rawEvent)
            });
          }
        }
        return sessionInfoDeltas;
      }
      default:
        return unhandledDeltas(rawEvent);"""

SESSION_NEW_ANCHOR = """      sessionId = newSession.sessionId;
      await selectAcpNativeModel({"""

SESSION_NEW_HOOK = """      sessionId = newSession.sessionId;
      const primeAgentSessionNewMeta = newSession._meta;
      if (primeAgentIsRecord(primeAgentSessionNewMeta)) {
        dialect.sessionNew?.(primeAgentSessionNewMeta, { threadId: bbThreadId });
      }
      await selectAcpNativeModel({"""

HEADER_RULE = "=" * 76


def sdk_package_json() -> dict:
    pkg = ROOT / "node_modules" / "@get-bb" / "plugin-sdk" / "package.json"
    if not pkg.exists():
        raise SystemExit(f"SDK package.json not found at {pkg}; run npm install first")
    return json.loads(pkg.read_text(encoding="utf-8"))


def generated_header(sdk_version: str) -> str:
    lines = [
        "// " + HEADER_RULE,
        "// VENDORED FILE -- DO NOT EDIT BY HAND.",
        f"// Source: @get-bb/plugin-sdk@{sdk_version} dist/provider-bridge-acp.js",
        "//         + prime-agent ACP dialect injected by scripts/apply-dialect.py",
        f"// Generated: {datetime.date.today().isoformat()}",
        "// Re-generate after an SDK bump: see the header in scripts/apply-dialect.py",
        "// " + HEADER_RULE,
        "",
        "",
    ]
    return "\n".join(lines)


def build_patched_source(dialect_source: str, sdk_source: str) -> str:
    if V3_MARKER in sdk_source:
        raise SystemExit("fresh SDK copy already contains the dialect marker; unexpected")
    if sdk_source.count(DIALECT_MAP_BLOCK) != 1:
        raise SystemExit(
            f"dialect registration anchor not unique ({sdk_source.count(DIALECT_MAP_BLOCK)}); "
            "the SDK layout changed -- re-review scripts/apply-dialect.py anchors"
        )
    patched = sdk_source.replace(
        DIALECT_MAP_BLOCK,
        DIALECT_MAP_BLOCK_REPLACED.replace("__DIALECT_SOURCE__", dialect_source.rstrip()),
        1,
    )
    if patched.count(DEFAULT_BLOCK) != 1:
        raise SystemExit(
            f"default-block anchor not unique ({patched.count(DEFAULT_BLOCK)}); "
            "the SDK layout changed -- re-review scripts/apply-dialect.py anchors"
        )
    patched = patched.replace(DEFAULT_BLOCK, SESSION_INFO_CASE, 1)
    if patched.count(SESSION_NEW_ANCHOR) != 1:
        raise SystemExit(
            f"session/new anchor not unique ({patched.count(SESSION_NEW_ANCHOR)}); "
            "the SDK layout changed -- re-review scripts/apply-dialect.py anchors"
        )
    patched = patched.replace(SESSION_NEW_ANCHOR, SESSION_NEW_HOOK, 1)
    if V3_MARKER not in patched:
        raise SystemExit("post-patch invariant failed: V3 marker missing")
    return patched


def syntax_check(path: Path) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "check.mjs"
        shutil.copyfile(path, copy)
        result = subprocess.run(["node", "--check", str(copy)], capture_output=True, text=True)
        if result.returncode != 0:
            raise SystemExit(f"syntax check failed:\n{result.stderr}")


def main() -> None:
    sdk_pkg = sdk_package_json()
    sdk_version = str(sdk_pkg.get("version", "unknown"))
    dialect_source = DIALECT.read_text(encoding="utf-8")
    if "primeAgentSessionInfoActions" not in dialect_source:
        raise SystemExit("dialect source does not define primeAgentSessionInfoActions")

    if "--check" in sys.argv:
        # Verify the vendored file matches what this script would generate from
        # the SDK copy in node_modules right now (header excluded).
        fresh = ROOT / "node_modules" / "@get-bb" / "plugin-sdk" / "dist" / "provider-bridge-acp.js"
        if not fresh.exists():
            raise SystemExit(f"SDK bridge not found at {fresh}; run npm install first")
        expected = build_patched_source(dialect_source, fresh.read_text(encoding="utf-8"))
        actual = VENDORED.read_text(encoding="utf-8")
        header_end = actual.find("// " + HEADER_RULE, actual.find("// VENDORED FILE"))
        actual_body = actual[actual.find("\n", header_end) + 1 :].lstrip("\n") if header_end > 0 else actual
        if actual_body == expected:
            print(f"vendor/ is up to date with @get-bb/plugin-sdk@{sdk_version}")
            return
        if V3_MARKER not in actual:
            raise SystemExit("vendor/ is missing the dialect (V3 marker absent) -- run apply")
        raise SystemExit(
            f"vendor/ drifts from @get-bb/plugin-sdk@{sdk_version}: re-vendor with "
            "`cp node_modules/@get-bb/plugin-sdk/dist/provider-bridge-acp.js vendor/ "
            "&& python3 scripts/apply-dialect.py`"
        )

    source = VENDORED.read_text(encoding="utf-8")
    if V3_MARKER in source:
        print("already applied (V3 marker present)")
        return

    patched = build_patched_source(dialect_source, source)
    patched = generated_header(sdk_version) + patched

    tmp_out = VENDORED.with_suffix(".js.tmp")
    tmp_out.write_text(patched, encoding="utf-8")
    syntax_check(tmp_out)
    tmp_out.replace(VENDORED)
    syntax_check(VENDORED)
    print(f"applied dialect to {VENDORED} ({len(patched)} bytes, sdk@{sdk_version})")


if __name__ == "__main__":
    main()
