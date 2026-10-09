// End-to-end check against a real amp, through the MCP protocol.
//   npm run smoke -- <blank slot to test saving in>
// Switches presets briefly, saves a test tone into the given slot and undoes
// it, then returns the amp to the slot it started on. History and snapshots
// go to a temporary directory.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const testSlot = Number(process.argv[2]);
if (!Number.isInteger(testSlot)) {
  console.error("Usage: npm run smoke -- <blank slot>");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "ltamp-mcp-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", join(import.meta.dirname, "..", "src", "index.ts")],
  env: { ...process.env, LTAMP_MCP_HOME: home } as Record<string, string>,
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

let failures = 0;
async function call(name: string, args: Record<string, unknown> = {}, expectError = false) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  const passed = Boolean(result.isError) === expectError;
  if (!passed) failures++;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}${expectError ? " (expected refusal)" : ""}`);
  if (!passed || expectError) console.log("     " + text.split("\n")[0].slice(0, 160));
  return expectError ? text : JSON.parse(text);
}

try {
  const { tools } = await client.listTools();
  console.log(`Tools: ${tools.map((t) => t.name).join(", ")}\n`);

  const status = await call("amp_status");
  console.log(`     on slot ${status.currentSlot} "${status.currentName}" — ${status.currentChain}`);

  const presets = await call("list_presets");
  const target = presets.find((p: { slot: number }) => p.slot === testSlot);
  console.log(`     ${presets.length} slots; ${presets.filter((p: { blank: boolean }) => p.blank).length} blank`);
  if (!target?.blank) throw new Error(`Slot ${testSlot} isn't blank; pick a blank slot for the save test`);

  const catalog = await call("get_catalog");
  for (const [block, models] of Object.entries(catalog)) {
    console.log(`     ${block}: ${Object.keys(models as object).filter((m) => m !== "Passthru").join(", ")}`);
  }

  const numb = await call("get_preset", { slot: 41 });
  console.log(`     slot 41: "${numb.tone.name}" amp=${numb.tone.amp.model}`);

  await call("audition_tone", { tone: { name: "bad", amp: { model: "NoSuchAmp" } } }, true);
  const auditioned = await call("audition_tone", {
    tone: { name: "smoke test", amp: { model: "Twin65", params: { volume: -20 } }, reverb: { model: "Spring65" } },
  });
  console.log(`     warnings: ${JSON.stringify(auditioned.warnings)}`);
  console.log(`     auditioning now: ${(await call("amp_status")).auditioning}`);
  await call("stop_audition");

  const loaded = await call("load_preset", { slot: 41 });
  console.log(`     loaded slot ${loaded.slot} "${loaded.name}"`);
  await call("load_preset", { slot: status.currentSlot });

  const tone = { name: "SMOKE TEST", amp: { model: "Twin65", params: { volume: -20 } } };
  const saved = await call("save_tone", { slot: testSlot, tone, note: "smoke test" });
  console.log(`     saved to ${saved.slot}, history #${saved.historyId}`);
  await call("save_tone", { slot: testSlot, tone }, true);
  await call("save_tone", { slot: 40, tone }, true);

  const history = await call("history");
  console.log(`     history: ${history.map((h: { id: number; afterName: string }) => `#${h.id} ${h.afterName}`).join(", ")}`);
  await call("undo", { id: saved.historyId });

  const after = await call("get_preset", { slot: testSlot });
  console.log(`     slot ${testSlot} blank again: ${after.blank}`);
  if (!after.blank) failures++;

  const final = await call("amp_status");
  console.log(`     back on slot ${final.currentSlot} "${final.currentName}"`);
} catch (e) {
  failures++;
  console.error("ERROR", e);
} finally {
  await client.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
