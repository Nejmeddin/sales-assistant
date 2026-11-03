import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { agentRuns, conversations, escalations, knowledge, orders } from "../src/db/schema.js";
import { EscalationService } from "../src/escalation/service.js";
import { formatInZone } from "../src/integrations/sheets.js";
import { APP_ID, IG_ID, PAGE_ID, messengerText, setupApp } from "./helpers.js";

const textOf = (req: { messages: { parts: { type: string; text?: string }[] }[] }) =>
  req.messages.at(-1)!.parts.map((p) => p.text ?? "").join("\n");

describe("webhook security", () => {
  it("answers the verification handshake only with the right token", async () => {
    const { http } = await setupApp();
    const ok = await http.request("/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42");
    expect(await ok.text()).toBe("42");
    const ko = await http.request("/webhooks/meta?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42");
    expect(ko.status).toBe(403);
  });

  it("rejects payloads with an invalid signature", async () => {
    const { postWebhook, deps } = await setupApp();
    const res = await postWebhook(messengerText("u1", "salut"), "wrong-secret");
    expect(res.status).toBe(401);
    expect(await deps.db.query.messages.findMany()).toHaveLength(0);
  });
});

describe("conversation flow", () => {
  it("identifies the product from an ad, answers, collects the order and writes it to the daily sheet tab", async () => {
    const app = await setupApp();
    const product = await app.deps.products.create({
      name: "Robe d'été fleurie",
      description: "Robe légère 100% coton. Livraison partout en Tunisie.",
      price: 59,
      variants: [{ name: "Taille", options: ["S", "M", "L"] }],
      adIds: ["ad_123"],
    } as never);

    const script = [
      // Turn 1: client asks about the ad product.
      async (req: import("../src/agent/providers/types.js").AgentRequest) => {
        expect(textOf(req)).toContain(`Produit concerné : [${product.id}]`);
        expect(req.system).toContain("Robe d'été fleurie");
        const details = (await req.executeTool("get_product", { product_id: product.id })) as { available: boolean };
        expect(details.available).toBe(true); // inStock not filled ⇒ available
        return "Oui elle est dispo à 59 TND 😍 Pour commander, envoie ton nom, ta ville, ton numéro et ta taille !";
      },
      // Turn 2: client sends all order details at once.
      async (req: import("../src/agent/providers/types.js").AgentRequest) => {
        const res = (await req.executeTool("update_order", {
          customer_name: "Amine Ben Ali",
          phone: "22 123 456",
          city: "Sfax",
          options: [{ name: "taille", value: "m" }],
        })) as { missing: string[]; problems: string[] };
        expect(res.problems).toEqual([]);
        expect(res.missing).toEqual([]);
        expect(await req.executeTool("submit_order", {})).toMatchObject({ ok: true });
        return "Merci Amine 🙏 Ta commande est enregistrée, on t'appelle pour confirmer !";
      },
    ];
    app.provider["script"].push(...script);

    await app.postWebhook(messengerText("psid_1", "Bonjour, elle est disponible ?", { referral: { source: "ADS", ad_id: "ad_123", type: "OPEN_THREAD" } }));
    await app.drain();
    await app.postWebhook(messengerText("psid_1", "Amine Ben Ali, Sfax, 22123456, taille M"));
    await app.drain();

    expect(app.graph.sent().map((s) => s.text)).toEqual([
      "Oui elle est dispo à 59 TND 😍 Pour commander, envoie ton nom, ta ville, ton numéro et ta taille !",
      "Merci Amine 🙏 Ta commande est enregistrée, on t'appelle pour confirmer !",
    ]);

    const [order] = await app.db.select().from(orders);
    expect(order).toMatchObject({ customerName: "Amine Ben Ali", phone: "+21622123456", city: "Sfax", options: { Taille: "M" }, status: "synced" });

    const tab = formatInZone(order!.submittedAt!, "Africa/Tunis", "YYYY-MM-DD");
    expect(app.sheets.rows).toHaveLength(1);
    expect(app.sheets.rows[0]!.tab).toBe(tab);
    expect(app.sheets.rows[0]!.row).toEqual(expect.arrayContaining(["Amine Ben Ali", "+21622123456", "Sfax", "Robe d'été fleurie", "Taille: M"]));

    const conv = await app.db.query.conversations.findFirst();
    expect(conv?.stage).toBe("ordered");
    expect(await app.db.select().from(agentRuns)).toHaveLength(2);
  });

  it("debounces a burst of messages into a single reply", async () => {
    const app = await setupApp();
    await app.deps.settings.set("bot", { debounceMs: 0 });
    app.provider["script"].push(async (req) => {
      const last = textOf(req);
      expect(last).toContain("salut");
      expect(last).toContain("c'est combien ?");
      return "Salut 👋 De quel produit parles-tu ?";
    });
    await app.postWebhook(messengerText("psid_2", "salut"));
    await app.postWebhook(messengerText("psid_2", "c'est combien ?"));
    await app.drain();
    expect(app.graph.sent()).toHaveLength(1);
  });

  it("ignores webhook redeliveries of the same message", async () => {
    const app = await setupApp();
    app.provider["script"].push(async () => "Bonjour !");
    const payload = messengerText("psid_3", "bonjour");
    await app.postWebhook(payload);
    await app.postWebhook(payload);
    await app.drain();
    expect(app.graph.sent()).toHaveLength(1);
  });

  it("refuses submitting an order with missing variant choice and invalid phone", async () => {
    const app = await setupApp();
    const product = await app.deps.products.create({ name: "Basket", price: 120, variants: [{ name: "Pointure", options: ["40", "41"] }] } as never);
    app.provider["script"].push(async (req) => {
      await req.executeTool("get_product", { product_id: product.id });
      const res = (await req.executeTool("update_order", { customer_name: "Sara", phone: "123", city: "Tunis" })) as { problems: string[]; missing: string[] };
      expect(res.problems[0]).toMatch(/invalide/);
      expect(res.missing).toEqual(["phone", "option:Pointure (40/41)"]);
      expect(await req.executeTool("submit_order", {})).toMatchObject({ error: "Champs manquants" });
      return "Peux-tu me redonner ton numéro et ta pointure ? 😊";
    });
    await app.postWebhook(messengerText("psid_4", "je veux la basket"));
    await app.drain();
    expect(await app.db.select().from(orders).where(eq(orders.status, "submitted"))).toHaveLength(0);
  });
});

describe("escalation & learning loop", () => {
  it("escalates unknown questions by e-mail, sends the team answer and reuses it as knowledge", async () => {
    const app = await setupApp();
    app.provider["script"].push(async (req) => {
      await req.executeTool("escalate_to_human", { question: "Livrez-vous à Djerba ?", reason: "Zone de livraison inconnue" });
      return "Je vérifie avec l'équipe et je reviens vers toi très vite 🙏";
    });
    await app.postWebhook(messengerText("psid_5", "Vous livrez à Djerba ?"));
    await app.drain();

    const [esc] = await app.db.select().from(escalations);
    expect(esc).toMatchObject({ status: "open", question: "Livrez-vous à Djerba ?" });
    expect((await app.db.query.conversations.findFirst())?.status).toBe("escalated");
    expect(app.mailer.sent).toHaveLength(1);
    expect(app.mailer.sent[0]!.to).toEqual(["owner@example.com"]);
    expect(app.mailer.sent[0]!.text).toContain(`https://bot.example.com/escalations/${esc!.id}`);

    await new EscalationService(app.deps).answer(esc!.id, { answer: "Oui, livraison à Djerba en 48h 🚚", saveAsKnowledge: true });
    expect(app.graph.sent().at(-1)).toMatchObject({ to: "psid_5", text: "Oui, livraison à Djerba en 48h 🚚", tag: undefined });
    expect((await app.db.query.conversations.findFirst())?.status).toBe("active");

    const learned = await app.deps.knowledge.search("livraison djerba");
    expect(learned[0]?.answer).toBe("Oui, livraison à Djerba en 48h 🚚");
    expect(await app.db.select().from(knowledge)).toHaveLength(1);
  });

  it("uses the HUMAN_AGENT tag when the team answers after 24 hours", async () => {
    const app = await setupApp();
    app.provider["script"].push(async (req) => {
      await req.executeTool("escalate_to_human", { question: "Garantie ?", reason: "Inconnu" });
      return "Je vérifie 🙏";
    });
    await app.postWebhook(messengerText("psid_6", "il y a une garantie ?"));
    await app.drain();
    await app.db.update(conversations).set({ lastInboundAt: new Date(Date.now() - 30 * 3_600_000) });
    const [esc] = await app.db.select().from(escalations);
    await new EscalationService(app.deps).answer(esc!.id, { answer: "Garantie 6 mois ✅", saveAsKnowledge: false });
    expect(app.graph.sent().at(-1)?.tag).toBe("HUMAN_AGENT");
  });

  it("hands over to a human when the AI fails, so the client is never ignored", async () => {
    const app = await setupApp();
    app.deps.createProvider = () => {
      throw new Error("No API key configured for gemini");
    };
    await app.postWebhook(messengerText("psid_7", "bonsoir"));
    await app.drain();
    expect(app.graph.sent()[0]?.text).toContain("je reviens vers toi");
    expect(await app.db.select().from(escalations)).toHaveLength(1);
  });
});

describe("human takeover", () => {
  it("pauses the bot when a human answers from Meta Business Suite", async () => {
    const app = await setupApp();
    app.provider["script"].push(async () => "Bonjour 👋");
    await app.postWebhook(messengerText("psid_8", "bonjour"));
    await app.drain();

    // Echo of our own bot message (same app id) is ignored…
    await app.postWebhook({
      object: "page",
      entry: [{ id: PAGE_ID, messaging: [{ sender: { id: PAGE_ID }, recipient: { id: "psid_8" }, timestamp: Date.now(), message: { mid: "m_echo_bot", text: "Bonjour 👋", is_echo: true, app_id: Number(APP_ID) } }] }],
    });
    expect((await app.db.query.conversations.findFirst())?.botPausedUntil).toBeNull();

    // …but a message typed by a human pauses the bot for this conversation.
    await app.postWebhook({
      object: "page",
      entry: [{ id: PAGE_ID, messaging: [{ sender: { id: PAGE_ID }, recipient: { id: "psid_8" }, timestamp: Date.now(), message: { mid: "m_echo_human", text: "C'est Sami, je m'en occupe", is_echo: true } }] }],
    });
    expect((await app.db.query.conversations.findFirst())?.botPausedUntil?.getTime()).toBeGreaterThan(Date.now());

    await app.postWebhook(messengerText("psid_8", "ok merci"));
    await app.drain();
    expect(app.graph.sent()).toHaveLength(1); // no bot reply while paused
  });
});

describe("instagram", () => {
  it("routes Instagram DMs to the linked page and replies through it", async () => {
    const app = await setupApp();
    app.provider["script"].push(async () => "Hello 👋");
    await app.postWebhook({
      object: "instagram",
      entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: "igsid_1" }, recipient: { id: IG_ID }, timestamp: Date.now(), message: { mid: "ig_m_1", text: "hi, price?" } }] }],
    });
    await app.drain();
    const contact = await app.db.query.contacts.findFirst();
    expect(contact).toMatchObject({ channel: "instagram", pageId: PAGE_ID, externalId: "igsid_1" });
    expect(app.graph.calls.some((c) => c.path === `${PAGE_ID}/messages` && c.body?.message)).toBe(true);
  });
});
