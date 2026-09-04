import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[]) => CommandResult;

const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
};

function executable(name: string, runner: CommandRunner): string | undefined {
  const result = runner("sh", ["-lc", `command -v ${shellQuote(name)}`]);
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function detectPackageManager(platform: NodeJS.Platform, runner: CommandRunner): string | undefined {
  const candidates = platform === "darwin"
    ? ["brew"]
    : platform === "linux"
      ? ["apt-get", "dnf", "pacman"]
      : [];
  return candidates.find((name) => executable(name, runner));
}

function pythonCandidates(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["python"] : ["python3", "python"];
}

function findPython(platform: NodeJS.Platform, runner: CommandRunner): string | undefined {
  return pythonCandidates(platform).map((name) => executable(name, runner)).find(Boolean);
}

function privilegedCommand(packageManager: string, runner: CommandRunner): { command: string; prefix: string[] } {
  if (packageManager === "brew" || process.getuid?.() === 0) return { command: packageManager, prefix: [] };
  const sudo = executable("sudo", runner);
  if (sudo) return { command: sudo, prefix: [packageManager] };
  return { command: packageManager, prefix: [] };
}

function installPython(packageManager: string, runner: CommandRunner): void {
  const { command, prefix } = privilegedCommand(packageManager, runner);
  const args = packageManager === "apt-get"
    ? ["update"]
    : packageManager === "dnf"
      ? ["makecache"]
      : packageManager === "pacman"
        ? ["-Sy", "--noconfirm"]
        : [];
  const managerArgs = packageManager === "apt-get"
    ? ["install", "-y", "python3", "python3-venv", "python3-pip"]
    : packageManager === "dnf"
      ? ["install", "-y", "python3", "python3-pip"]
      : packageManager === "pacman"
        ? ["-S", "--noconfirm", "python", "python-pip"]
        : ["install", "python"];

  if (packageManager !== "brew") {
    const cache = runner(command, [...prefix, ...args]);
    if (cache.status !== 0) {
      throw new Error(`Failed to prepare ${packageManager}: ${cache.stderr.trim() || `exit ${cache.status}`}`);
    }
  }

  const install = runner(command, [...prefix, ...managerArgs]);
  if (install.status !== 0) {
    throw new Error(`Failed to install Python with ${packageManager}: ${install.stderr.trim() || `exit ${install.status}`}`);
  }
}

function runOrThrow(runner: CommandRunner, command: string, args: string[], label: string): void {
  const result = runner(command, args);
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
}

function ensureVenvPip(runner: CommandRunner, venvPython: string): void {
  const check = runner(venvPython, ["-m", "pip", "--version"]);
  if (check.status === 0) return;

  const bootstrap = runner(venvPython, ["-m", "ensurepip", "--upgrade"]);
  if (bootstrap.status !== 0) {
    throw new Error(
      `The Chroma virtual environment has no pip and ensurepip is unavailable: ${
        bootstrap.stderr.trim() || `exit ${bootstrap.status}`
      }. Install Python with venv/pip support, then run 'aira start' again.`,
    );
  }

  runOrThrow(runner, venvPython, ["-m", "pip", "--version"], "Bootstrapping pip in the Chroma virtual environment");
}

export function chromaExecutable(root: string): string {
  return resolve(root, ".aira/chroma-venv/bin/chroma");
}

export async function ensureChroma(
  root: string,
  options: { platform?: NodeJS.Platform; runner?: CommandRunner } = {},
): Promise<string> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? defaultRunner;
  const chroma = chromaExecutable(root);

  if (existsSync(chroma)) return chroma;
  if (platform === "win32") {
    throw new Error("Automatic Python/Chroma setup is not supported on Windows; use Linux, macOS, or install Python manually.");
  }

  mkdirSync(dirname(chroma), { recursive: true });
  let python = findPython(platform, runner);
  if (!python) {
    const packageManager = detectPackageManager(platform, runner);
    if (!packageManager) {
      throw new Error("Python is missing and no supported package manager was found. Install Python 3 with venv support, then run `aira start` again.");
    }
    installPython(packageManager, runner);
    python = findPython(platform, runner);
    if (!python) {
      throw new Error(`Python installation via ${packageManager} completed, but python3 was not found on PATH. Restart the shell or add Python to PATH, then run 'aira start' again.`);
    }
  }

  const venv = resolve(root, ".aira/chroma-venv");
  if (!existsSync(resolve(venv, "bin/python"))) {
    runOrThrow(runner, python, ["-m", "venv", venv], "Creating the Chroma virtual environment");
  }

  const venvPython = resolve(venv, "bin/python");
  ensureVenvPip(runner, venvPython);
  runOrThrow(runner, venvPython, ["-m", "pip", "install", "chromadb"], "Installing Chroma");

  if (!existsSync(chroma)) {
    throw new Error(`Chroma installation completed but ${chroma} was not created. Run '${venvPython} -m pip install chromadb' manually and retry.`);
  }
  return chroma;
}
