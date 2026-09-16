import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type BbPluginApi } from "@get-bb/plugin-sdk";

const execFileAsync = promisify(execFile);

// Path installs run server.ts from the plugin root (bin/ is a sibling);
// marketplace installs run the built dist/server.js, so the launcher lives
// one level up. Resolve both.
function resolveLauncherPath(): string {
  const local = new URL("./bin/launch.mjs", import.meta.url);
  if (existsSync(local)) return fileURLToPath(local);
  return fileURLToPath(new URL("../bin/launch.mjs", import.meta.url));
}
const launcherPath = resolveLauncherPath();
const INSTALL_URL = "https://app.primeintellect.ai/prime-agent/install.sh";

// The ACP launch spec is sent to whatever host daemon executes the thread, so
// an absolute path resolved on the server breaks on every other machine
// (remote daemons do not share the server's plugin cache). Register a stable
// PATH-based launcher name instead and make `bb prime-agent install` place
// the bundled launch.mjs at that name on the local machine.
const LAUNCHER_NAME = "prime-agent-acp-launch";

function launcherInstallDirs(): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${process.env.HOME ?? ""}/.local/bin`,
  ].filter((d) => d.length > 0 && !d.startsWith("/.local"));
}

// Copy the bundled launch.mjs onto PATH under the stable launcher name so the
// ACP launch spec works on this machine. Remote machines need the same one-time
// step (the script is plain Node stdlib, so it runs anywhere node exists).
function installLauncherOnPath(): string {
  for (const dir of launcherInstallDirs()) {
    try {
      if (!existsSync(dir)) continue;
      const dest = `${dir}/${LAUNCHER_NAME}`;
      copyFileSync(launcherPath, dest);
      chmodSync(dest, 0o755);
      return `Launcher installed at ${dest}`;
    } catch {
      // try next dir
    }
  }
  return `WARNING: could not install ${LAUNCHER_NAME} launcher onto PATH; threads on this machine will not start`;
}

// Resolve the installed prime-agent binary via PATH (the launcher execs the
// binary for ACP runs only; management commands must call the binary itself).
async function resolvePrimeAgentBinary(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("which", ["prime-agent"]);
    return stdout.split(/\r?\n/u)[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

export default async function plugin(bb: BbPluginApi) {
  bb.providers.register({
    id: "acp-prime-agent",
    displayName: "Prime Agent",
    family: "acp",
    icon: "./icons/prime-agent.svg",
    strings: {
      signInHint:
        "Ensure Prime Agent is installed and authenticated (`prime-agent /login` or `bb prime-agent install`).",
      expiredHint:
        "Prime Agent session expired or needs re-authentication. Check your API keys with `prime-agent`.",
      installUrl: "https://app.primeintellect.ai/prime-agent/install.sh",
      iconTint: { light: "#9333EA", dark: "#C084FC" },
    },
    experimental_visibility: "installed",
    models: { scope: "host" },
    maintenance: { health: true, usage: false, installation: false },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      supportsManualCompaction: true,
      supportsThreadArchive: true,
      supportsThreadRename: true,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      // "minimal" is a valid prime-agent --thinking level but bb's
      // PluginProviderReasoningLevel union has no such member (0.4.84), so it
      // cannot be declared here until bb extends the vocabulary.
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    // Extension kinds the prime-agent dialect emits (see
    // dialect/prime-agent-dialect.js). The server validates payloads against
    // these schemas at ingest and persists a provider/unhandled on a miss.
    extensionKinds: {
      goal: {
        state: z
          .object({
            objective: z.string(),
            status: z.enum(["active", "paused", "budgetLimited", "complete"]),
            tokenBudget: z.number().nullable(),
            tokensUsed: z.number(),
            timeUsedSeconds: z.number(),
          })
          .nullable(),
        item: z.object({
          transition: z.enum([
            "started",
            "resumed",
            "completed",
            "paused",
            "budget_limited",
            "error",
          ]),
          objective: z.string(),
          status: z.string(),
          tokenBudget: z.number().nullable(),
          tokensUsed: z.number(),
          timeUsedSeconds: z.number(),
        }),
      },
      refinement: {
        item: z.object({
          status: z.enum(["complete", "failed"]),
          summary: z.string().optional(),
          changes: z.array(z.string()).optional(),
          error: z.string().optional(),
        }),
      },
      "agent-message": {
        item: z.object({
          target: z.string().optional(),
          deliveryStatus: z.string().optional(),
          toolCallId: z.string().optional(),
        }),
      },
    },
    experimental_bridgeOptions: {
      // Resolve the dialect by id (also matched by launcher basename as a
      // fallback). See dialect/prime-agent-dialect.js.
      acpDialect: "prime-agent",
      acpLaunchSpec: {
        displayName: "Prime Agent",
        command: LAUNCHER_NAME,
        args: [],
        env: {},
        modelCli: {
          // prime-agent 0.9+ removed --list-models; the catalog command is
          // `prime-agent model list`.
          listArgs: ["model", "list"],
          selectFlag: "--model",
          primaryModels: ["openrouter/minimax/minimax-m3:free"],
        },
        reasoningCli: {
          flag: "--thinking",
          supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
          levelValues: { none: "off" },
          defaultLevel: "high",
        },
      },
    },
  });

  bb.cli.register({
    name: "prime-agent",
    summary: "Inspect and manage the Prime Agent ACP provider",
    commands: [
      {
        name: "status",
        summary: "Show the Prime Agent launcher and resolved binary status",
        usage: "bb prime-agent status [--json]",
      },
      {
        name: "models",
        summary: "List available models discovered by Prime Agent",
        usage: "bb prime-agent models [--json]",
      },
      {
        name: "install",
        summary: "Download and install the official Prime Agent binary (requires --yes)",
        usage: "bb prime-agent install --yes",
      },
      {
        name: "sessions",
        summary: "List Prime Agent sessions and running agents",
        usage: "bb prime-agent sessions [--all] [--json]",
      },
      {
        name: "doctor",
        summary: "Inspect and clean up Prime Agent background services",
        usage: "bb prime-agent doctor [--fix] [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const cmd = argv[0];

      if (cmd === "install") {
        if (!argv.includes("--yes")) {
          return {
            exitCode: 1,
            stderr: [
              "This downloads and executes a shell script from Prime Intellect:",
              `  ${INSTALL_URL}`,
              "It installs the official prime-agent binary into your home directory.",
              "",
              "Re-run with --yes to confirm: `bb prime-agent install --yes`",
            ].join("\n"),
            stdout: "",
          };
        }
        try {
          const { stdout, stderr } = await execFileAsync(launcherPath, ["--install", "--yes"]);
          const launcherMsg = installLauncherOnPath();
          return {
            exitCode: 0,
            stdout: `${stdout || stderr || "Prime Agent installed."}\n${launcherMsg}`,
            stderr: "",
          };
        } catch (err: any) {
          const stderr = err?.stderr?.toString?.() ?? "";
          return {
            exitCode: 1,
            stderr: `Failed to install Prime Agent: ${err.message ?? err}${stderr ? `\n${stderr}` : ""}`,
            stdout: err?.stdout?.toString?.() ?? "",
          };
        }
      }

      if (cmd === "models") {
        try {
          const { stdout } = await execFileAsync(launcherPath, ["model", "list"]);
          if (json) {
            const models = stdout
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const parts = line.split(" - ");
                return { id: parts[0]?.trim(), name: parts[1]?.trim() };
              });
            return { exitCode: 0, stdout: JSON.stringify({ ok: true, models }, null, 2) };
          }
          return { exitCode: 0, stdout };
        } catch (err: any) {
          return {
            exitCode: 1,
            stderr: `Failed to query models: ${err.message ?? err}`,
            stdout: "",
          };
        }
      }

      if (cmd === "sessions") {
        const bin = await resolvePrimeAgentBinary();
        if (!bin) {
          return {
            exitCode: 1,
            stderr: "Prime Agent is not installed. Run `bb prime-agent install --yes` first.",
            stdout: "",
          };
        }
        const listArgs = ["list"];
        if (argv.includes("--all")) listArgs.push("--all");
        listArgs.push("--json");
        try {
          const { stdout } = await execFileAsync(bin, listArgs);
          if (json) {
            return { exitCode: 0, stdout, stderr: "" };
          }
          const parsed = JSON.parse(stdout) as { sessions?: unknown[] };
          const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
          if (sessions.length === 0) {
            return { exitCode: 0, stdout: "No Prime Agent sessions.", stderr: "" };
          }
          const lines = sessions.map((raw) => {
            const row = (raw ?? {}) as Record<string, any>;
            const id = typeof row.id === "string" ? row.id : "?";
            const lifecycle = typeof row.lifecycle === "string" ? row.lifecycle : "?";
            const activity = typeof row.activity === "string" ? row.activity : "?";
            const model =
              row.model && typeof row.model === "object" && typeof (row.model as any).id === "string"
                ? (row.model as any).id
                : "?";
            const cwd = typeof row.cwd === "string" ? row.cwd : "";
            return `${id}  ${lifecycle}/${activity}  ${model}  ${cwd}`;
          });
          return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
        } catch (err: any) {
          return {
            exitCode: 1,
            stderr: `Failed to list Prime Agent sessions: ${err.message ?? err}`,
            stdout: "",
          };
        }
      }

      if (cmd === "doctor") {
        const bin = await resolvePrimeAgentBinary();
        if (!bin) {
          return {
            exitCode: 1,
            stderr: "Prime Agent is not installed. Run `bb prime-agent install --yes` first.",
            stdout: "",
          };
        }
        const doctorArgs = ["doctor"];
        if (argv.includes("--fix")) doctorArgs.push("--fix");
        if (json) doctorArgs.push("--json");
        try {
          const { stdout } = await execFileAsync(bin, doctorArgs);
          return { exitCode: 0, stdout, stderr: "" };
        } catch (err: any) {
          // doctor exits non-zero when it finds problems; pass its output through.
          return {
            exitCode: typeof err?.code === "number" ? err.code : 1,
            stdout: err?.stdout?.toString?.() ?? "",
            stderr: err?.stderr?.toString?.() ?? `Failed to run Prime Agent doctor: ${err.message ?? err}`,
          };
        }
      }

      // Default to status command
      const resolvedBinary = await resolvePrimeAgentBinary();

      let launcherOnPath: string | null = null;
      try {
        const { stdout } = await execFileAsync("which", [LAUNCHER_NAME]);
        launcherOnPath = stdout.split(/\r?\n/u)[0]?.trim() ?? null;
      } catch {
        launcherOnPath = null;
      }

      let primeAgentVersion: string | null = null;
      let daemonStatus: unknown = null;
      let runningAgentCount: number | null = null;
      if (resolvedBinary !== null) {
        try {
          primeAgentVersion = (await execFileAsync(resolvedBinary, ["--version"])).stdout.trim() || null;
        } catch {
          primeAgentVersion = null;
        }
        try {
          daemonStatus = JSON.parse((await execFileAsync(resolvedBinary, ["status", "--json"])).stdout);
        } catch {
          daemonStatus = null;
        }
        try {
          const listed = JSON.parse((await execFileAsync(resolvedBinary, ["list", "--json"])).stdout) as {
            sessions?: unknown[];
          };
          runningAgentCount = Array.isArray(listed.sessions) ? listed.sessions.length : null;
        } catch {
          runningAgentCount = null;
        }
      }

      const status = {
        providerId: "acp-prime-agent",
        displayName: "Prime Agent",
        launcher: launcherPath,
        launcherName: LAUNCHER_NAME,
        launcherOnPath,
        resolvedBinary,
        primeAgentVersion,
        daemon: daemonStatus,
        runningAgents: runningAgentCount,
        ready: resolvedBinary !== null && launcherOnPath !== null,
        hint:
          resolvedBinary === null
            ? "Prime Agent is not yet installed. Run `bb prime-agent install --yes` to download it."
            : launcherOnPath === null
              ? `Prime Agent binary found, but the ${LAUNCHER_NAME} launcher is missing from PATH. Re-run \`bb prime-agent install --yes\` to install it.`
              : "Ready. Prime Agent appears in bb provider list and agent selectors.",
      };

      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(status, null, 2)
          : [
              `providerId:     ${status.providerId}`,
              `displayName:    ${status.displayName}`,
              `launcher:       ${status.launcher}`,
              `launcherOnPath: ${status.launcherOnPath ?? "NOT ON PATH"}`,
              `resolvedBinary: ${status.resolvedBinary ?? "NOT FOUND"}`,
              `version:        ${status.primeAgentVersion ?? "UNKNOWN"}`,
              `daemon:         ${
                Array.isArray(status.daemon) && status.daemon.length > 0
                  ? `RUNNING (pid ${(status.daemon as any[])[0]?.pid ?? "?"}, sessions ${(status.daemon as any[])[0]?.sessionCount ?? "?"})`
                  : "NOT RUNNING"
              }`,
              `runningAgents:  ${status.runningAgents ?? "UNKNOWN"}`,
              `status:         ${status.ready ? "READY" : "MISSING BINARY"}`,
              "",
              status.hint,
            ].join("\n"),
      };
    },
  });
}
