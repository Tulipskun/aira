export type ProcessKind = "daemon" | "bot" | "chroma";

export type AiraProcess = {
  pid: number;
  kind: ProcessKind;
};

export function parseProcessTable(table: string): Array<{ pid: number; args: string }> {
  const processes: Array<{ pid: number; args: string }> = [];
  for (const line of table.split("\n")) {
    const match = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    processes.push({ pid: Number(match[1]), args: match[2] });
  }
  return processes;
}

export function selectAiraProcesses(processes: Array<{ pid: number; args: string }>): AiraProcess[] {
  const selected: AiraProcess[] = [];
  for (const process of processes) {
    if (process.args.includes("scripts/daemon.ts")) {
      selected.push({ pid: process.pid, kind: "daemon" });
    } else if (process.args.includes("src/bot/bot.ts")) {
      selected.push({ pid: process.pid, kind: "bot" });
    } else if (process.args.includes("chroma-venv/bin/chroma")) {
      selected.push({ pid: process.pid, kind: "chroma" });
    }
  }
  return selected;
}
