import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { splitMessage } from "../src/channels/meta/client.js";
import { parseWebhook } from "../src/channels/meta/parser.js";
import { decrypt, encrypt, hashPassword, verifyPassword } from "../src/lib/crypto.js";
import { normalizePhone } from "../src/orders/service.js";
import { JobQueue } from "../src/queue/queue.js";
import { SettingsService } from "../src/settings/service.js";
import { formatInZone } from "../src/integrations/sheets.js";
import { testDb } from "./helpers.js";

describe("crypto", () => {
  it("round-trips encrypted values and verifies passwords", async () => {
    const key = randomBytes(32).toString("base64");
    expect(decrypt(encrypt("secret ✓", key), key)).toBe("secret ✓");
    const hash = await hashPassword("hunter22");
    expect(await verifyPassword("hunter22", hash)).toBe(true);
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });
});

describe("settings", () => {
  it("encrypts secrets at rest, masks them for the dashboard and keeps them when sent back masked", async () => {
    const db = await testDb();
    const key = randomBytes(32).toString("base64");
    const svc = new SettingsService(db, key);
    await svc.set("ai", { provider: "gemini", gemini: { apiKey: "AIzaSy-super-secret-1234", model: "gemini-2.5-flash" } });

    const { rows } = await db.execute<{ value: { gemini: { apiKey: string } } }>(sql`SELECT value FROM settings WHERE key = 'ai'`);
    expect(rows[0]!.value.gemini.apiKey).toMatch(/^enc:v1:/);

    const pub = await svc.getPublic("ai");
    expect(pub.gemini.apiKey).toBe("••••1234");

    await svc.set("ai", { ...pub, provider: "anthropic" });
    const after = await svc.get("ai");
    expect(after.gemini.apiKey).toBe("AIzaSy-super-secret-1234");
    expect(after.provider).toBe("anthropic");
    expect(after.anthropic.model).toBe("claude-haiku-5-5");
  });
});

describe("parser", () => {
  it("normalises Messenger messages, ad referrals, shared posts and echoes", () => {
    const events = parseWebhook(
      {
        object: "page",
        entry: [
          {
            id: "P1",
            messaging: [
              { sender: { id: "U1" }, recipient: { id: "P1" }, timestamp: 1, message: { mid: "a", text: "prix ?", attachments: [{ type: "fallback", payload: { url: "https://facebook.com/x/posts/1234567890" } }] } },
              { sender: { id: "U1" }, recipient: { id: "P1" }, timestamp: 2, referral: { source: "ADS", ad_id: "AD9", ads_context_data: { post_id: "P1_555" } } },
              { sender: { id: "P1" }, recipient: { id: "U1" }, timestamp: 3, message: { mid: "b", text: "ok", is_echo: true, app_id: 42 } },
            ],
          },
        ],
      },
      () => undefined,
    );
    expect(events.map((e) => e.kind)).toEqual(["message", "referral", "echo"]);
    expect(events[0]).toMatchObject({ channel: "messenger", senderId: "U1", attachments: [{ url: "https://facebook.com/x/posts/1234567890" }] });
    expect(events[1]).toMatchObject({ referral: { adId: "AD9", postId: "P1_555" } });
    expect(events[2]).toMatchObject({ recipientId: "U1", appId: "42" });
  });

  it("drops Instagram events for unknown accounts and garbage payloads", () => {
    expect(parseWebhook({ object: "instagram", entry: [{ id: "IG", messaging: [{ sender: { id: "u" }, recipient: { id: "IG" }, message: { mid: "x", text: "hi" } }] }] }, () => undefined)).toEqual([]);
    expect(parseWebhook({ hello: "world" }, () => undefined)).toEqual([]);
  });
});

describe("helpers", () => {
  it("normalises Tunisian phone numbers", () => {
    expect(normalizePhone("22 123 456", "TN")).toBe("+21622123456");
    expect(normalizePhone("+216 98 765 432", "TN")).toBe("+21698765432");
    expect(normalizePhone("1234", "TN")).toBeUndefined();
  });

  it("splits long replies under the channel limit", () => {
    const long = Array.from({ length: 40 }, (_, i) => `Phrase numéro ${i} avec un peu de texte.`).join(" ");
    const parts = splitMessage(long, "instagram");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join(" ")).toBe(long);
  });

  it("formats daily tab names in the shop timezone", () => {
    // 23:30 UTC on Dec 31 is already Jan 1 in Tunis (UTC+1).
    expect(formatInZone(new Date("2026-12-31T23:30:00Z"), "Africa/Tunis", "YYYY-MM-DD")).toBe("2027-01-01");
  });
});

describe("job queue", () => {
  it("debounces by key, serialises per key and retries failures", async () => {
    const db = await testDb();
    const queue = new JobQueue(db);
    const seen: unknown[] = [];
    let fail = true;
    queue.register("t", async (payload) => {
      if (fail) {
        fail = false;
        throw new Error("boom");
      }
      seen.push(payload);
    });
    await queue.enqueue("t", "k", { v: 1 }, { debounce: true });
    await queue.enqueue("t", "k", { v: 2 }, { debounce: true });
    expect(await queue.tick()).toBe(1); // one job only, fails
    await db.execute(sql`UPDATE jobs SET run_at = now()`); // skip backoff
    expect(await queue.tick()).toBe(1);
    expect(seen).toEqual([{ v: 2 }]);
  });
});
