import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { History } from "./history.js";
import { AmpSession, SLOT_COUNT } from "./session.js";
import {
  BLOCKS,
  buildPreset,
  isBlank,
  NAME_LENGTH,
  parsePreset,
  presetName,
  summarize,
  toTone,
  ToneError,
  type Tone,
} from "./tone.js";

const INSTRUCTIONS = `Controls a Fender Mustang LT guitar amp connected over USB.

A tone is five blocks in series: stomp → mod → amp → delay → reverb. Each block
has a model and settings. Omit a block (or use model "Passthru") to turn it off.
Only list the settings you want to change; the rest are filled in from the
catalog. Call get_catalog to see which models and settings exist on this amp.

Settings are mostly 0–1 (knob position). Exceptions: amp "volume" and some
stomp "level" settings are in dB (negative, 0 is loudest); delay "time" is in
seconds. Keep amp volume at or below about -8 dB unless the user asks for more.

Workflow: audition_tone first so the user can hear it, then ask before
save_tone. Saving overwrites a slot on the amp. Slot names are not reliable:
list_presets reports which slots are truly blank. Every save is recorded and
can be reverted with undo.`;

const slot = z.number().int().min(1).max(SLOT_COUNT).describe(`Preset slot, 1–${SLOT_COUNT}`);
const paramValue = z.union([z.number(), z.string(), z.boolean()]);
const block = z
  .object({
    model: z.string().describe('Model name without the DUBS_ prefix, e.g. "BigFuzz", "DR103", "MonoDelay"'),
    params: z.record(z.string(), paramValue).optional().describe("Settings to change; omitted ones use defaults"),
    enabled: z.boolean().optional().describe("false bypasses the block. Default true"),
  })
  .describe("One effect or amp block");
const tone = z.object({
  name: z.string().describe(`Shown on the amp's display; up to ${NAME_LENGTH} characters`),
  stomp: block.optional(),
  mod: block.optional(),
  amp: block,
  delay: block.optional(),
  reverb: block.optional(),
});

function ok(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a handler so thrown errors come back as tool errors instead of crashing the call. */
function safe<A>(handler: (args: A) => Promise<CallToolResult>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (e) {
      return fail(e);
    }
  };
}

function nameWarnings(t: Tone): string[] {
  return t.name.length > NAME_LENGTH ? [`Name shortened to "${t.name.slice(0, NAME_LENGTH)}"`] : [];
}

export function createServer(session = new AmpSession(), history = new History()): McpServer {
  const server = new McpServer({ name: "ltamp-mcp", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    "amp_status",
    {
      title: "Amp status",
      description: "Firmware, model, the loaded slot, whether it has unsaved edits, and whether a tone is being auditioned.",
      annotations: readOnly,
    },
    safe(async () =>
      session.use(async (amp) => {
        const current = await amp.currentPreset();
        const preset = parsePreset(current.json);
        return ok({
          product: await amp.productId(),
          firmware: await amp.firmwareVersion(),
          currentSlot: current.slot,
          currentName: presetName(preset),
          currentChain: summarize(preset),
          unsavedEdits: current.dirty,
          auditioning: await amp.isAuditioning(),
        });
      }),
    ),
  );

  server.registerTool(
    "list_presets",
    {
      title: "List presets",
      description:
        "All 60 slots with name, signal chain and whether the slot is truly blank. Names like EMPTY can still hold real tones; trust `blank`, not the name.",
      annotations: readOnly,
    },
    safe(async () =>
      session.use(async (amp) => {
        const slots = await session.readAll(amp);
        return ok(
          slots.map((s) => {
            const p = parsePreset(s.json);
            return { slot: s.slot, name: presetName(p), chain: summarize(p), blank: isBlank(p) };
          }),
        );
      }),
    ),
  );

  server.registerTool(
    "get_preset",
    {
      title: "Get preset",
      description: "Full settings of a stored slot, in the same tone format audition_tone and save_tone accept.",
      inputSchema: { slot },
      annotations: readOnly,
    },
    safe(async ({ slot }) =>
      session.use(async (amp) => {
        const p = parsePreset((await amp.getPreset(slot)).json);
        return ok({ slot, blank: isBlank(p), tone: toTone(p) });
      }),
    ),
  );

  server.registerTool(
    "get_current_tone",
    {
      title: "Get current tone",
      description: "What the amp is playing right now, including knob changes that haven't been saved.",
      annotations: readOnly,
    },
    safe(async () =>
      session.use(async (amp) => {
        const current = await amp.currentPreset();
        return ok({ slot: current.slot, unsavedEdits: current.dirty, tone: toTone(parsePreset(current.json)) });
      }),
    ),
  );

  server.registerTool(
    "get_catalog",
    {
      title: "Get catalog",
      description:
        "Models available for each block and their settings: type, the range of values seen on this amp, defaults, and presets that use them as examples.",
      inputSchema: { block: z.enum(BLOCKS).optional().describe("Only this block; omit for all") },
      annotations: readOnly,
    },
    safe(async ({ block }) =>
      session.use(async (amp) => {
        const catalog = await session.getCatalog(amp);
        return ok(block ? { [block]: catalog[block] } : catalog);
      }),
    ),
  );

  server.registerTool(
    "audition_tone",
    {
      title: "Audition tone",
      description:
        "Play a tone on the amp without saving it. The amp stays on it until stop_audition, the preset knob is turned, or another tone is auditioned. Returns the full settings used and any warnings.",
      inputSchema: { tone },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ tone }) =>
      session.use(async (amp) => {
        const { preset, warnings } = buildPreset(tone, await session.getCatalog(amp));
        await amp.audition(JSON.stringify(preset));
        return ok({ auditioning: true, warnings: [...nameWarnings(tone), ...warnings], tone: toTone(preset) });
      }),
    ),
  );

  server.registerTool(
    "stop_audition",
    {
      title: "Stop audition",
      description: "Return the amp to the preset in its current slot.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async () =>
      session.use(async (amp) => {
        await amp.exitAudition();
        return ok({ auditioning: false });
      }),
    ),
  );

  server.registerTool(
    "load_preset",
    {
      title: "Load preset",
      description: "Switch the amp to a stored slot, like turning the preset knob. Doesn't change any stored preset.",
      inputSchema: { slot },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    safe(async ({ slot }) =>
      session.use(async (amp) => {
        await amp.loadPreset(slot);
        const current = await amp.currentPreset();
        const p = parsePreset(current.json);
        return ok({ slot: current.slot, name: presetName(p), chain: summarize(p) });
      }),
    ),
  );

  server.registerTool(
    "save_tone",
    {
      title: "Save tone",
      description:
        "Write a tone into a slot on the amp. Ask the user first. Refuses to replace a slot that isn't blank unless overwrite is true. The previous contents are recorded in history and can be restored with undo.",
      inputSchema: {
        slot,
        tone,
        overwrite: z.boolean().optional().describe("Required to replace a slot that holds a tone"),
        note: z.string().optional().describe("Why this was saved; shown in history"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ slot, tone, overwrite, note }) =>
      session.use(async (amp) => {
        const { preset, warnings } = buildPreset(tone, await session.getCatalog(amp));
        const before = (await amp.getPreset(slot)).json;
        const beforePreset = parsePreset(before);
        if (!isBlank(beforePreset) && !overwrite) {
          return fail(
            `Slot ${slot} holds "${presetName(beforePreset)}" (${summarize(beforePreset)}). ` +
              "Confirm with the user, then call again with overwrite: true. It can be restored with undo.",
          );
        }

        const json = JSON.stringify(preset);
        await amp.savePreset(slot, json);
        const after = (await amp.getPreset(slot)).json;
        if (parsePreset(after).info?.preset_id !== preset.info?.preset_id) {
          throw new Error(`The amp didn't store the tone in slot ${slot} (read-back mismatch)`);
        }

        const entry = history.add({
          action: "save",
          slot,
          before,
          after,
          beforeName: presetName(beforePreset),
          afterName: presetName(preset),
          note,
        });
        return ok({
          saved: true,
          slot,
          name: presetName(preset),
          replaced: presetName(beforePreset),
          historyId: entry.id,
          warnings: [...nameWarnings(tone), ...warnings],
        });
      }),
    ),
  );

  server.registerTool(
    "history",
    {
      title: "History",
      description: "Recent slot writes, newest first. Use an entry's id with undo.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("Default 20") },
      annotations: readOnly,
    },
    safe(async ({ limit }) =>
      ok(
        history
          .all()
          .reverse()
          .slice(0, limit ?? 20)
          .map(({ before, after, ...rest }) => rest),
      ),
    ),
  );

  server.registerTool(
    "undo",
    {
      title: "Undo",
      description:
        "Restore a slot to what it was before a history entry. If the slot was changed again since, this refuses unless force is true.",
      inputSchema: {
        id: z.number().int().describe("History entry id"),
        force: z.boolean().optional().describe("Restore even if the slot changed after that entry"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    safe(async ({ id, force }) => {
      const entry = history.get(id);
      if (!entry) return fail(`No history entry ${id}`);
      return session.use(async (amp) => {
        const current = (await amp.getPreset(entry.slot)).json;
        const currentPreset = parsePreset(current);
        const expectedId = parsePreset(entry.after).info?.preset_id;
        if (currentPreset.info?.preset_id !== expectedId && !force) {
          return fail(
            `Slot ${entry.slot} has changed since entry ${id}; it now holds "${presetName(currentPreset)}". ` +
              "Call again with force: true to restore anyway (the current contents are recorded first).",
          );
        }
        await amp.savePreset(entry.slot, entry.before);
        const restored = (await amp.getPreset(entry.slot)).json;
        const undoEntry = history.add({
          action: "undo",
          slot: entry.slot,
          before: current,
          after: restored,
          beforeName: presetName(currentPreset),
          afterName: entry.beforeName,
          undoes: id,
        });
        return ok({ restored: true, slot: entry.slot, name: entry.beforeName, historyId: undoEntry.id });
      });
    }),
  );

  return server;
}

export { ToneError };
