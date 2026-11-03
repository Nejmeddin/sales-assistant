import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { settings as settingsTable } from "../db/schema.js";
import { decrypt, encrypt, isEncrypted } from "../lib/crypto.js";
import { SECRET_FIELDS, SettingsSchema, type Settings, type SettingsKey } from "./schema.js";

const MASK = "••••";

type Json = Record<string, unknown>;

/** Applies `fn` to every value addressed by a dotted path such as `pages[].accessToken`. */
function mapPath(obj: unknown, path: string, fn: (value: unknown, existingSibling?: unknown) => unknown): void {
  const [head, ...rest] = path.split(".");
  if (!head || obj === null || typeof obj !== "object") return;
  const isArray = head.endsWith("[]");
  const key = isArray ? head.slice(0, -2) : head;
  const container = obj as Json;
  if (isArray) {
    const list = container[key];
    if (Array.isArray(list)) for (const item of list) mapPath(item, rest.join("."), fn);
  } else if (rest.length === 0) {
    if (key in container) container[key] = fn(container[key]);
  } else {
    mapPath(container[key], rest.join("."), fn);
  }
}

function getPath(obj: unknown, path: string[]): unknown {
  return path.reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Json)[k] : undefined), obj);
}

export function maskSecret(value: string): string {
  if (!value) return "";
  return value.length <= 8 ? MASK : `${MASK}${value.slice(-4)}`;
}

export function isMasked(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MASK);
}

export class SettingsService {
  private cache = new Map<SettingsKey, { value: unknown; at: number }>();
  private static readonly TTL_MS = 5_000;

  constructor(
    private readonly db: Db,
    private readonly encryptionKey: string,
  ) {}

  async get<K extends SettingsKey>(key: K): Promise<Settings[K]> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SettingsService.TTL_MS) return structuredClone(hit.value) as Settings[K];

    const [row] = await this.db.select().from(settingsTable).where(eq(settingsTable.key, key));
    const raw = structuredClone((row?.value ?? {}) as Json);
    for (const path of SECRET_FIELDS[key]) {
      mapPath(raw, path, (v) => (isEncrypted(v) ? decrypt(v, this.encryptionKey) : v));
    }
    const value = SettingsSchema[key].parse(raw) as Settings[K];
    this.cache.set(key, { value, at: Date.now() });
    return structuredClone(value);
  }

  async getAll(): Promise<Settings> {
    const keys = Object.keys(SettingsSchema) as SettingsKey[];
    const entries = await Promise.all(keys.map(async (k) => [k, await this.get(k)] as const));
    return Object.fromEntries(entries) as Settings;
  }

  /** Same as get() but with secrets masked — safe to send to the dashboard. */
  async getPublic<K extends SettingsKey>(key: K): Promise<Settings[K]> {
    const value = (await this.get(key)) as Json;
    for (const path of SECRET_FIELDS[key]) mapPath(value, path, (v) => (typeof v === "string" ? maskSecret(v) : v));
    return value as Settings[K];
  }

  /**
   * Replaces a settings section. Secret fields sent back masked (unchanged in the UI)
   * keep their stored value. Array items are matched by index for that purpose
   * (pages are matched by pageId).
   */
  async set<K extends SettingsKey>(key: K, input: unknown): Promise<Settings[K]> {
    const current = (await this.get(key)) as Json;
    const next = SettingsSchema[key].parse(input) as Json;

    for (const path of SECRET_FIELDS[key]) {
      const segments = path.split(".");
      const arrayIdx = segments.findIndex((s) => s.endsWith("[]"));
      if (arrayIdx === -1) {
        const value = getPath(next, segments);
        if (isMasked(value)) {
          const parent = getPath(next, segments.slice(0, -1)) as Json;
          parent[segments.at(-1)!] = getPath(current, segments);
        }
        continue;
      }
      // Array of objects (e.g. pages[].accessToken): match by pageId, else by index.
      const listPath = [...segments.slice(0, arrayIdx), segments[arrayIdx]!.slice(0, -2)];
      const field = segments.slice(arrayIdx + 1);
      const nextList = (getPath(next, listPath) as Json[] | undefined) ?? [];
      const currentList = (getPath(current, listPath) as Json[] | undefined) ?? [];
      nextList.forEach((item, i) => {
        if (!isMasked(getPath(item, field))) return;
        const previous = currentList.find((c) => c.pageId !== undefined && c.pageId === item.pageId) ?? currentList[i];
        const parent = getPath(item, field.slice(0, -1)) as Json;
        parent[field.at(-1)!] = previous ? getPath(previous, field) : "";
      });
    }

    const stored = structuredClone(next);
    for (const path of SECRET_FIELDS[key]) {
      mapPath(stored, path, (v) => (typeof v === "string" && v !== "" ? encrypt(v, this.encryptionKey) : v));
    }
    await this.db
      .insert(settingsTable)
      .values({ key, value: stored })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: stored, updatedAt: new Date() } });
    this.cache.delete(key);
    return next as Settings[K];
  }

  invalidate(): void {
    this.cache.clear();
  }
}
