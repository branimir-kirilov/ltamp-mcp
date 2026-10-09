import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { History } from "../src/history.js";

describe("History", () => {
  it("numbers entries and finds them by id", () => {
    const history = new History(mkdtempSync(join(tmpdir(), "ltamp-mcp-")));
    const base = { action: "save" as const, slot: 41, before: "{}", after: "{}", beforeName: "EMPTY", afterName: "X" };
    expect(history.add(base).id).toBe(1);
    expect(history.add({ ...base, afterName: "Y" }).id).toBe(2);
    expect(history.get(2)?.afterName).toBe("Y");
    expect(history.all()).toHaveLength(2);
  });
});
