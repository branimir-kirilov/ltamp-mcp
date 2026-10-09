// Owns the USB connection. Opens on first use and closes after a quiet
// period, so other apps (like Fender Tone) can use the amp in between calls.

import { LtAmp, NodeHidTransport } from "ltamp-js/node";
import { buildCatalog, parsePreset, type Catalog } from "ltamp-js";
import { writeSnapshot } from "./history.js";

export const SLOT_COUNT = 60;

export interface SessionOptions {
  /** Close the connection after this long without a call, in ms. Default 15000. */
  idleTimeout?: number;
  /** Back up all slots on the first connection. Default true. */
  snapshot?: boolean;
}

export class AmpSession {
  private amp?: LtAmp;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private lock: Promise<unknown> = Promise.resolve();
  private catalog?: Catalog;
  private snapshotTaken = false;
  private readonly idleTimeout: number;
  private readonly snapshot: boolean;

  constructor(options: SessionOptions = {}) {
    this.idleTimeout = options.idleTimeout ?? 15_000;
    this.snapshot = options.snapshot ?? true;
  }

  /** Run `fn` with a connected amp. Calls are serialized. */
  use<T>(fn: (amp: LtAmp) => Promise<T>): Promise<T> {
    const run = async () => {
      clearTimeout(this.idleTimer);
      try {
        const amp = await this.connect();
        return await fn(amp);
      } catch (e) {
        // A failed call may mean the amp went away; reconnect next time.
        await this.disconnect();
        throw e;
      } finally {
        this.idleTimer = setTimeout(() => void this.withLock(() => this.disconnect()), this.idleTimeout);
        this.idleTimer.unref?.();
      }
    };
    return this.withLock(run);
  }

  /** Read every slot in order. */
  readAll(amp: LtAmp): Promise<{ slot: number; json: string }[]> {
    return (async () => {
      const slots = [];
      for (let slot = 1; slot <= SLOT_COUNT; slot++) slots.push(await amp.getPreset(slot));
      return slots;
    })();
  }

  /** Models and settings learned from the amp's presets. Built once per server run. */
  async getCatalog(amp: LtAmp): Promise<Catalog> {
    if (!this.catalog) {
      const slots = await this.readAll(amp);
      this.catalog = buildCatalog(slots.map((s) => parsePreset(s.json)));
    }
    return this.catalog;
  }

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    await this.withLock(() => this.disconnect());
  }

  private async connect(): Promise<LtAmp> {
    if (this.amp) return this.amp;
    const amp = new LtAmp(await NodeHidTransport.open());
    try {
      await amp.connect();
    } catch (e) {
      await amp.close().catch(() => {});
      throw e;
    }
    this.amp = amp;

    if (this.snapshot && !this.snapshotTaken) {
      // Back up everything before this session can change anything.
      const slots = await this.readAll(amp);
      const file = writeSnapshot(slots);
      this.catalog ??= buildCatalog(slots.map((s) => parsePreset(s.json)));
      this.snapshotTaken = true;
      console.error(`ltamp-mcp: backed up all slots to ${file}`);
    }
    return amp;
  }

  private async disconnect(): Promise<void> {
    const amp = this.amp;
    this.amp = undefined;
    await amp?.close().catch(() => {});
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn, fn);
    this.lock = result.catch(() => {});
    return result;
  }
}
