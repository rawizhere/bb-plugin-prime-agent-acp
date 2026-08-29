import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { type BbPluginApi } from "@get-bb/plugin-sdk";

const execFileAsync = promisify(execFile);

const launcherPath = fileURLToPath(new URL("./bin/launch.mjs", import.meta.url));
const INSTALL_URL = "https://app.primeintellect.ai/prime-agent/install.sh";

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

      // status (default)
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
