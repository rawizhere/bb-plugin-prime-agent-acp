import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, copyFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    composerActions: [],
    experimental_bridgeOptions: {
      acpLaunchSpec: {
        displayName: "Prime Agent",
        command: LAUNCHER_NAME,
        args: [],
        env: {},
        modelCli: {
          listArgs: ["--list-models"],
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

      // Default to status command
      let resolvedBinary: string | null = null;
      try {
        const { stdout } = await execFileAsync("which", ["prime-agent"]);
        resolvedBinary = stdout.split(/\r?\n/u)[0]?.trim() ?? null;
      } catch {
        resolvedBinary = null;
      }

      let launcherOnPath: string | null = null;
      try {
        const { stdout } = await execFileAsync("which", [LAUNCHER_NAME]);
        launcherOnPath = stdout.split(/\r?\n/u)[0]?.trim() ?? null;
      } catch {
        launcherOnPath = null;
      }

      const status = {
        providerId: "acp-prime-agent",
        displayName: "Prime Agent",
        launcher: launcherPath,
        launcherName: LAUNCHER_NAME,
        launcherOnPath,
        resolvedBinary,
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
              `status:         ${status.ready ? "READY" : "MISSING BINARY"}`,
              "",
              status.hint,
            ].join("\n"),
      };
    },
  });
}
