import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { type BbPluginApi } from "@get-bb/plugin-sdk";

const execFileAsync = promisify(execFile);

const launcherPath = fileURLToPath(new URL("./bin/launch.mjs", import.meta.url));
const INSTALL_URL = "https://app.primeintellect.ai/prime-agent/install.sh";

const PROVIDER_ENV_VARS: Record<string, string> = {
  openrouter: "OPENROUTER_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  "prime-inference": "PRIME_API_KEY",
};

function readAuthProviders(): { path: string; exists: boolean; providers: string[] } {
  const agentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime", "agent");
  const path = join(agentDir, "auth.json");
  if (!existsSync(path)) {
    return { path, exists: false, providers: [] };
  }
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof data !== "object" || data === null) {
      return { path, exists: true, providers: [] };
    }
    const providers = Object.entries(data as Record<string, unknown>)
      .filter(([, value]) => {
        if (typeof value !== "object" || value === null) return false;
        const type = (value as Record<string, unknown>).type;
        return type === "api_key" || type === "oauth";
      })
      .map(([key]) => key);
    return { path, exists: true, providers };
  } catch {
    return { path, exists: true, providers: [] };
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
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      fork: "none",
      permissionModes: ["accept-edits", "full"],
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    experimental_bridgeOptions: {
      acpLaunchSpec: {
        displayName: "Prime Agent",
        command: launcherPath,
        args: [],
        env: {},
        modelCli: {
          listArgs: ["--list-models"],
          selectFlag: "--model",
          primaryModels: [
            "opencode-go/ox-alpha-free",
            "opencode/ox-alpha-free",
            "openrouter/z-ai/glm-5.2:free",
            "openrouter/minimax/minimax-m3:free",
            "openrouter/minimax/minimax-m3",
            "opencode/deepseek-v4-flash",
          ],
        },
        reasoningCli: {
          flag: "--thinking",
          supportedLevels: ["low", "high", "max"],
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
        name: "auth",
        summary: "Show configured provider credentials for Prime Agent",
        usage: "bb prime-agent auth [--json]",
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
          return { exitCode: 0, stdout: stdout || stderr || "Prime Agent installed.", stderr: "" };
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
          const { stdout } = await execFileAsync(launcherPath, ["--list-models"]);
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

      if (cmd === "auth") {
        const auth = readAuthProviders();
        const detected = new Set([
          ...auth.providers,
          ...Object.entries(PROVIDER_ENV_VARS)
            .filter(([, envVar]) => Boolean(process.env[envVar]))
            .map(([provider]) => provider),
        ]);
        const rows = [...detected].sort().map((provider) => {
          const envVar = PROVIDER_ENV_VARS[provider];
          return {
            provider,
            authFile: auth.providers.includes(provider),
            env: Boolean(envVar && process.env[envVar]),
            envVar: envVar ?? null,
          };
        });
        const openrouter = rows.find((row) => row.provider === "openrouter");
        const notes: string[] = [];
        notes.push(`Auth file: ${auth.path}${auth.exists ? "" : " (missing)"}`);
        if (auth.providers.length > 0) {
          notes.push(`Auth file providers: ${auth.providers.join(", ")}`);
        }
        if (openrouter?.authFile || openrouter?.env) {
          notes.push(
            "OpenRouter: a key is configured. If turns fail with `403 Key limit exceeded`," +
              " the key's total usage limit is exhausted. Replace it with a new key or fund the workspace.",
          );
          notes.push(
            "If you see `No API key found for openrouter` after a 403, Prime Agent marks the" +
              " failed key stale in a long-running daemon. Replace the key with a different value (or" +
              " start a fresh thread) to clear it.",
          );
        } else {
          notes.push(
            "OpenRouter: no key configured. Add an openrouter entry to ~/.prime/agent/auth.json," +
              " export OPENROUTER_API_KEY in the environment bb starts from, or run `prime-agent` and `/login`.",
          );
        }
        if (json) {
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, auth, providers: rows, notes }, null, 2) };
        }
        const lines = [
          "Auth status for Prime Agent",
          `Auth file: ${auth.path}${auth.exists ? "" : " (missing)"}`,
        ];
        if (auth.providers.length > 0) {
          lines.push(`Auth file providers: ${auth.providers.join(", ")}`);
        }
        lines.push("");
        if (rows.length === 0) {
          lines.push("No known provider credentials found.", "");
        } else {
          for (const row of rows) {
            lines.push(
              `${row.provider.padEnd(16)} auth-file: ${row.authFile ? "yes" : "no"}    env: ${row.env ? "yes (" + row.envVar + ")" : "no"}`,
            );
          }
          lines.push("");
        }
        lines.push(...notes);
        return { exitCode: 0, stdout: lines.join("\n") };
      }

      // Default to status command
      let resolvedBinary: string | null = null;
      try {
        const { stdout } = await execFileAsync("which", ["prime-agent"]);
        resolvedBinary = stdout.split(/\r?\n/u)[0]?.trim() ?? null;
      } catch {
        resolvedBinary = null;
      }

      const status = {
        providerId: "acp-prime-agent",
        displayName: "Prime Agent",
        launcher: launcherPath,
        resolvedBinary,
        ready: resolvedBinary !== null,
        hint:
          resolvedBinary === null
            ? "Prime Agent is not yet installed. Run `bb prime-agent install --yes` to download it."
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
              `resolvedBinary: ${status.resolvedBinary ?? "NOT FOUND"}`,
              `status:         ${status.ready ? "READY" : "MISSING BINARY"}`,
              "",
              status.hint,
            ].join("\n"),
      };
    },
  });
}
