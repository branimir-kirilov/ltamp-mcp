// The list of models and settings the AI may use, learned from the presets on
// the connected amp. Nothing from Fender ships with this package; the amp
// itself is the source.

import { BLOCKS, shortModel, type BlockName, type ParamValue, type Preset } from "./tone.js";

export interface ParamSpec {
  type: "number" | "string" | "boolean";
  /** Smallest and largest values seen across the amp's presets (numbers only). */
  min?: number;
  max?: number;
  /** Values seen (strings only). */
  values?: string[];
}

export interface ModelEntry {
  params: Record<string, ParamSpec>;
  /** Settings used when the AI doesn't specify one: from the first preset that uses this model. */
  defaults: Record<string, ParamValue>;
  /** Preset names that use this model, as examples. */
  usedBy: string[];
}

export type Catalog = Record<BlockName, Record<string, ModelEntry>>;

const MAX_EXAMPLES = 4;

export function buildCatalog(presets: Preset[]): Catalog {
  const catalog = Object.fromEntries(BLOCKS.map((b) => [b, {}])) as Catalog;

  for (const preset of presets) {
    const name = preset.info?.displayName?.trim() ?? "";
    for (const node of preset.audioGraph?.nodes ?? []) {
      if (!(BLOCKS as readonly string[]).includes(node.nodeId)) continue;
      const model = shortModel(node.FenderId);
      const entry = (catalog[node.nodeId as BlockName][model] ??= { params: {}, defaults: {}, usedBy: [] });
      if (entry.usedBy.length < MAX_EXAMPLES && name && !entry.usedBy.includes(name)) entry.usedBy.push(name);

      for (const [key, value] of Object.entries(node.dspUnitParameters ?? {})) {
        if (key === "bypass" || key === "bypassType") continue;
        if (!(key in entry.defaults)) entry.defaults[key] = value;
        const type = typeof value as ParamSpec["type"];
        const spec = (entry.params[key] ??= { type });
        if (type === "number") {
          spec.min = Math.min(spec.min ?? Infinity, value as number);
          spec.max = Math.max(spec.max ?? -Infinity, value as number);
        } else if (type === "string") {
          spec.values ??= [];
          if (!spec.values.includes(value as string)) spec.values.push(value as string);
        }
      }
    }
  }
  return catalog;
}
