// The tone format the AI works with: five named blocks, each a model plus
// settings. Converted to and from the amp's full preset JSON here, so the AI
// never has to produce node graphs, connections or metadata.

import { randomUUID } from "node:crypto";
import type { Catalog } from "./catalog.js";

export const BLOCKS = ["stomp", "mod", "amp", "delay", "reverb"] as const;
export type BlockName = (typeof BLOCKS)[number];

export type ParamValue = number | string | boolean;

export interface Block {
  /** Model name without the DUBS_ prefix, e.g. "BigFuzz", "DR103". "Passthru" means the block is off. */
  model: string;
  /** Only the settings you want to change; the rest come from the catalog's defaults. */
  params?: Record<string, ParamValue>;
  /** false keeps the block in the chain but bypassed. Default true. */
  enabled?: boolean;
}

export interface Tone {
  name: string;
  stomp?: Block;
  mod?: Block;
  amp: Block;
  delay?: Block;
  reverb?: Block;
}

interface PresetNode {
  nodeId: string;
  nodeType: string;
  FenderId: string;
  dspUnitParameters: Record<string, ParamValue>;
}

export interface Preset {
  info?: { displayName?: string; preset_id?: string; [k: string]: unknown };
  audioGraph?: { nodes?: PresetNode[]; connections?: unknown[] };
  [k: string]: unknown;
}

const PREFIX = "DUBS_";
const OFF = "Passthru";
/** Settings that control on/off rather than sound; handled via `enabled`. */
const BYPASS_KEYS = new Set(["bypass", "bypassType"]);

export const NAME_LENGTH = 16;

export const shortModel = (fenderId: string) => fenderId.replace(PREFIX, "");
export const fenderId = (model: string) => (model.startsWith(PREFIX) ? model : PREFIX + model);

/** The amp's display fits 16 characters. */
export function displayName(name: string): string {
  return name.toUpperCase().slice(0, NAME_LENGTH).padEnd(NAME_LENGTH, " ");
}

export function parsePreset(json: string): Preset {
  return JSON.parse(json) as Preset;
}

export function presetName(preset: Preset): string {
  return preset.info?.displayName?.trim() ?? "";
}

function nodes(preset: Preset): PresetNode[] {
  return preset.audioGraph?.nodes ?? [];
}

/** Convert a stored preset into the AI-facing tone format. */
export function toTone(preset: Preset): Tone {
  const tone: Tone = { name: presetName(preset), amp: { model: OFF } };
  for (const node of nodes(preset)) {
    if (!(BLOCKS as readonly string[]).includes(node.nodeId)) continue;
    const params = Object.fromEntries(
      Object.entries(node.dspUnitParameters ?? {}).filter(([k]) => !BYPASS_KEYS.has(k)),
    );
    const block: Block = { model: shortModel(node.FenderId) };
    if (Object.keys(params).length) block.params = params;
    if (node.dspUnitParameters?.bypass === true) block.enabled = false;
    tone[node.nodeId as BlockName] = block;
  }
  return tone;
}

/** One-line summary: "BigFuzz → DR103 → MonoDelay → LargeHallReverb". */
export function summarize(preset: Preset): string {
  const active = nodes(preset)
    .filter((n) => n.FenderId !== PREFIX + OFF && n.dspUnitParameters?.bypass !== true)
    .map((n) => shortModel(n.FenderId));
  return active.join(" → ") || "(nothing)";
}

// The factory blank: every block off and a flat, cabinet-less amp.
const BLANK_AMP = {
  FenderId: "DUBS_LinearGain",
  params: { volume: 0, gatePreset: "off", gateDetectorPosition: "jack", cabsimType: "none", gain: 0.5, treb: 0.5, mid: 0.5, bass: 0.5 },
};

/**
 * True only when a slot holds the factory blank. Slot names are not
 * trustworthy: users leave real tones named "EMPTY".
 */
export function isBlank(preset: Preset): boolean {
  const all = nodes(preset);
  if (all.length !== BLOCKS.length) return false;
  return all.every((n) => {
    if (n.nodeId !== "amp") return n.FenderId === PREFIX + OFF;
    if (n.FenderId !== BLANK_AMP.FenderId) return false;
    const p = n.dspUnitParameters ?? {};
    const keys = Object.keys(p);
    return (
      keys.length === Object.keys(BLANK_AMP.params).length &&
      keys.every((k) => p[k] === BLANK_AMP.params[k as keyof typeof BLANK_AMP.params])
    );
  });
}

export interface BuildResult {
  preset: Preset;
  warnings: string[];
}

/**
 * Build a complete preset from a tone. Fills omitted settings from the
 * catalog and rejects unknown models, unknown settings and wrong types, so
 * mistakes surface here instead of as silence from the amp.
 */
export function buildPreset(tone: Tone, catalog: Catalog): BuildResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const graphNodes: PresetNode[] = BLOCKS.map((blockName) => {
    const block = tone[blockName] ?? { model: OFF };
    const id = fenderId(block.model);
    const base = { nodeId: blockName, nodeType: "dspUnit", FenderId: id };
    if (shortModel(id) === OFF) return { ...base, dspUnitParameters: {} };

    const entry = catalog[blockName]?.[shortModel(id)];
    if (!entry) {
      const known = Object.keys(catalog[blockName] ?? {}).filter((m) => m !== OFF);
      errors.push(`${blockName}: unknown model "${block.model}". Known: ${known.join(", ")}`);
      return { ...base, dspUnitParameters: {} };
    }

    const params: Record<string, ParamValue> = { ...entry.defaults };
    for (const [key, value] of Object.entries(block.params ?? {})) {
      const spec = entry.params[key];
      if (!spec) {
        errors.push(`${blockName} ${shortModel(id)}: unknown setting "${key}". Known: ${Object.keys(entry.params).join(", ")}`);
        continue;
      }
      if (typeof value !== spec.type) {
        errors.push(`${blockName} ${shortModel(id)}: "${key}" must be a ${spec.type}, got ${JSON.stringify(value)}`);
        continue;
      }
      if (spec.type === "number" && spec.min !== undefined && spec.max !== undefined) {
        // Most models appear in only a few presets, so the seen range is
        // narrow. Always allow the 0–1 knob range; warn only when off-scale.
        // Negative ranges are dB levels, where quieter is always safe.
        const v = value as number;
        const lo = spec.min < 0 ? Math.min(spec.min, -60) : Math.min(spec.min, 0);
        const hi = Math.max(spec.max, 1);
        if (v < lo || v > hi) {
          warnings.push(`${blockName} ${shortModel(id)}: ${key}=${v} looks off-scale (seen on this amp: ${lo} to ${hi})`);
        }
      }
      if (spec.type === "string" && spec.values && !spec.values.includes(value as string)) {
        warnings.push(`${blockName} ${shortModel(id)}: ${key}="${value}" hasn't been seen on this amp (seen: ${spec.values.join(", ")})`);
      }
      params[key] = value;
    }
    if (blockName !== "amp") {
      params.bypass = block.enabled === false;
      params.bypassType ??= blockName === "delay" || blockName === "reverb" ? "Pre" : "Post";
    }
    return { ...base, dspUnitParameters: params };
  });

  if (shortModel(fenderId(tone.amp?.model ?? OFF)) === OFF) errors.push("amp: a tone needs an amp model");
  if (errors.length) throw new ToneError(errors);

  const preset: Preset = {
    nodeType: "preset",
    nodeId: "preset",
    version: "1.1",
    numInputs: 2,
    numOutputs: 2,
    info: {
      displayName: displayName(tone.name),
      preset_id: randomUUID(),
      author: "",
      source_id: "",
      timestamp: Math.floor(Date.now() / 1000),
      created_at: 0,
      product_id: "mustang-lt",
      is_factory_default: false,
      bpm: 0,
    },
    audioGraph: { nodes: graphNodes, connections: chainConnections() },
  };
  return { preset, warnings };
}

/** Stereo series chain: input → stomp → mod → amp → delay → reverb → output. */
function chainConnections() {
  const order = ["preset", ...BLOCKS, "preset"];
  const out = [];
  for (let i = 0; i < order.length - 1; i++) {
    for (const index of [0, 1]) {
      out.push({ input: { nodeId: order[i], index }, output: { nodeId: order[i + 1], index } });
    }
  }
  return out;
}

export class ToneError extends Error {
  constructor(readonly problems: string[]) {
    super(`The tone has problems:\n- ${problems.join("\n- ")}`);
  }
}
