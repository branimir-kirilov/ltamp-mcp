// Append-only record of every slot write, so any change can be undone.
// Stored as JSON Lines in the data directory (~/.ltamp-mcp by default).

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HistoryEntry {
  id: number;
  time: string;
  action: "save" | "undo";
  slot: number;
  /** Full preset JSON before and after the write. */
  before: string;
  after: string;
  beforeName: string;
  afterName: string;
  note?: string;
  /** For undo entries: the entry that was undone. */
  undoes?: number;
}

export function dataDir(): string {
  return process.env.LTAMP_MCP_HOME ?? join(homedir(), ".ltamp-mcp");
}

export class History {
  private readonly file: string;

  constructor(dir = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "history.jsonl");
  }

  all(): HistoryEntry[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as HistoryEntry);
  }

  get(id: number): HistoryEntry | undefined {
    return this.all().find((e) => e.id === id);
  }

  add(entry: Omit<HistoryEntry, "id" | "time">): HistoryEntry {
    const last = this.all().at(-1);
    const full: HistoryEntry = { id: (last?.id ?? 0) + 1, time: new Date().toISOString(), ...entry };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
    return full;
  }
}

/** Save all 60 slots as one JSON file, named by time. */
export function writeSnapshot(slots: { slot: number; json: string }[], dir = dataDir()): string {
  const snapshotDir = join(dir, "snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  const file = join(snapshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(slots.map((s) => ({ slot: s.slot, preset: JSON.parse(s.json) }))));
  return file;
}
