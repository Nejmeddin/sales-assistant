import { z } from "zod";
import type { Deps } from "../app/deps.js";
import type { Conversation } from "../conversation/service.js";
import { EscalationService } from "../escalation/service.js";
import { missingFields, type Order } from "../orders/service.js";
import { isAvailable, type Product } from "../products/service.js";
import type { Settings } from "../settings/schema.js";
import type { ToolSpec } from "./providers/types.js";

export const JOB_ORDER_SHEET = "order.sheet";

/** Mutable state shared by the tools during one agent run. */
export type TurnState = {
  conversation: Conversation;
  product?: Product;
  order?: Order;
  escalated: boolean;
  submittedOrder?: Order;
  /** Text of the latest client message(s): default escalation question. */
  latestClientText: string;
};

type ToolDef<S extends z.ZodType> = {
  name: string;
  description: string;
  input: S;
  run: (input: z.infer<S>) => Promise<unknown>;
};

const tool = <S extends z.ZodType>(def: ToolDef<S>) => def;

export function buildTools(deps: Deps, state: TurnState, bot: Settings["bot"]) {
  const escalations = new EscalationService(deps);

  const productView = async (p: Product) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    available: isAvailable(p),
    options: p.variants,
    postDescription: p.description,
    supplierSpecs: p.sourceSpecs ?? null,
    storeUrl: p.storeUrl,
    validatedAnswers: (await deps.knowledge.search(`${p.name} ${state.latestClientText}`, { productId: p.id, limit: 3 })).map(
      ({ question, answer }) => ({ question, answer }),
    ),
  });

  const setProduct = async (p: Product) => {
    state.product = p;
    if (state.conversation.currentProductId !== p.id) {
      await deps.conversations.update(state.conversation.id, { currentProductId: p.id });
      state.conversation.currentProductId = p.id;
    }
  };

  const orderStatus = (order: Order) => ({
    order: {
      customerName: order.customerName,
      phone: order.phone,
      city: order.city,
      address: order.address,
      options: order.options,
      quantity: order.quantity,
    },
    missing: missingFields(order, state.product, bot.requiredOrderFields),
  });

  const defs = [
    tool({
      name: "get_product",
      description:
        "Retourne la fiche complète d'un produit du catalogue (description de la publication, prix, options, disponibilité, caractéristiques fournisseur, réponses validées) et le définit comme produit concerné par la conversation.",
      input: z.object({ product_id: z.string().describe("Identifiant du produit (entre crochets dans le catalogue)") }),
      run: async ({ product_id }) => {
        const p = await deps.products.get(product_id);
        if (!p || !p.active) return { error: "Produit introuvable. Utilise search_products ou demande au client de préciser." };
        await setProduct(p);
        return productView(p);
      },
    }),
    tool({
      name: "search_products",
      description: "Recherche des produits actifs du catalogue à partir des mots du client (nom, type, couleur…).",
      input: z.object({ query: z.string().min(1) }),
      run: async ({ query }) => {
        const hits = await deps.products.search(query);
        return hits.map((p) => ({ id: p.id, name: p.name, price: p.price, currency: p.currency, available: isAvailable(p) }));
      },
    }),
    tool({
      name: "search_knowledge",
      description: "Cherche dans les réponses validées par l'équipe (livraison, retours, utilisation des produits…).",
      input: z.object({ query: z.string().min(1) }),
      run: async ({ query }) => deps.knowledge.search(query, { productId: state.product?.id }),
    }),
    tool({
      name: "update_order",
      description:
        "Enregistre les informations de commande données par le client (même partielles). Retourne la commande et la liste des champs encore manquants.",
      input: z.object({
        customer_name: z.string().optional().describe("Nom complet"),
        phone: z.string().optional().describe("Numéro de téléphone tel que donné par le client"),
        city: z.string().optional(),
        address: z.string().optional().describe("Adresse complète si le client la donne"),
        options: z
          .array(z.object({ name: z.string().describe("Nom de l'option, ex: Taille"), value: z.string().describe("Choix, ex: M") }))
          .optional(),
        quantity: z.number().int().min(1).optional(),
        notes: z.string().optional(),
        product_id: z.string().optional().describe("À fournir si différent du produit concerné"),
      }),
      run: async (input) => {
        if (input.product_id && input.product_id !== state.product?.id) {
          const p = await deps.products.get(input.product_id);
          if (p) await setProduct(p);
        }
        const { order, problems } = await deps.orders.upsertDraft(
          state.conversation.id,
          {
            customerName: input.customer_name,
            phone: input.phone,
            city: input.city,
            address: input.address,
            quantity: input.quantity,
            notes: input.notes,
            options: input.options ? Object.fromEntries(input.options.map((o) => [o.name, o.value])) : undefined,
          },
          { phoneCountry: bot.phoneCountry, product: state.product },
        );
        state.order = order;
        if (state.conversation.stage === "answering") {
          await deps.conversations.update(state.conversation.id, { stage: "collecting_order" });
          state.conversation.stage = "collecting_order";
        }
        return { ...orderStatus(order), problems };
      },
    }),
    tool({
      name: "submit_order",
      description: "Valide la commande quand plus aucun champ ne manque. À appeler après avoir récapitulé la commande au client.",
      input: z.object({}),
      run: async () => {
        const order = state.order ?? (await deps.orders.draft(state.conversation.id));
        if (!order) return { error: "Aucune commande en cours. Utilise update_order d'abord." };
        const missing = missingFields(order, state.product, bot.requiredOrderFields);
        if (missing.length) return { error: "Champs manquants", missing };
        if (state.product && !isAvailable(state.product)) return { error: "Produit en rupture de stock : commande impossible." };
        const submitted = await deps.orders.markSubmitted(order.id);
        await deps.conversations.update(state.conversation.id, { stage: "ordered" });
        await deps.queue.enqueue(JOB_ORDER_SHEET, submitted.id, { orderId: submitted.id });
        state.order = undefined;
        state.submittedOrder = submitted;
        return { ok: true, orderId: submitted.id };
      },
    }),
    tool({
      name: "escalate_to_human",
      description:
        "Transmet à l'équipe une question à laquelle tu ne peux pas répondre avec les sources disponibles. L'équipe répondra au client et l'assistant apprendra de sa réponse.",
      input: z.object({
        question: z.string().min(3).describe("La question du client, reformulée clairement en français"),
        reason: z.string().min(3).describe("Pourquoi tu ne peux pas répondre (information absente, demande spéciale…)"),
      }),
      run: async ({ question, reason }) => {
        if (state.escalated) return { ok: true, note: "Déjà transmis pendant ce tour." };
        await escalations.create(state.conversation.id, { question, reason, productId: state.product?.id });
        state.escalated = true;
        return { ok: true };
      },
    }),
  ];

  const specs: ToolSpec[] = defs.map((d) => ({
    name: d.name,
    description: d.description,
    inputSchema: z.toJSONSchema(d.input) as Record<string, unknown>,
  }));

  const execute = async (name: string, input: unknown): Promise<unknown> => {
    const def = defs.find((d) => d.name === name);
    if (!def) return { error: `Outil inconnu: ${name}` };
    const parsed = (def.input as z.ZodType).safeParse(input ?? {});
    if (!parsed.success) return { error: "Paramètres invalides", details: z.prettifyError(parsed.error) };
    return (def.run as (i: unknown) => Promise<unknown>)(parsed.data);
  };

  return { specs, execute };
}
