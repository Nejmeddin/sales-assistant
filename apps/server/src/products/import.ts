import { z } from "zod";
import type { LlmProvider } from "../agent/providers/types.js";
import type { PagePost } from "../channels/meta/client.js";

export const ProductDraft = z.object({
  isProduct: z.boolean().describe("false si la publication ne présente pas un produit à vendre"),
  name: z.string(),
  price: z.number().nullable().describe("Prix numérique sans devise, null si absent"),
  currency: z.string().describe("Code devise, ex: TND"),
  variants: z.array(z.object({ name: z.string(), options: z.array(z.string()) })).describe("Options à choisir: Taille, Couleur…"),
  keywords: z.array(z.string()).describe("Mots-clés de recherche (synonymes, type de produit), en français"),
});
export type ProductDraft = z.infer<typeof ProductDraft>;

const SYSTEM = `Tu extrais la fiche produit d'une publication Facebook/Instagram d'une boutique en ligne.
N'invente rien : uniquement ce qui est écrit dans le texte. Si une information est absente, laisse-la vide (null ou liste vide).`;

/** Turns a page post into a product draft the owner reviews in the dashboard. */
export async function draftFromPost(provider: LlmProvider, post: PagePost, defaultCurrency: string) {
  const raw = await provider.generateJson({
    system: SYSTEM,
    prompt: `Devise par défaut : ${defaultCurrency}\n\nPublication :\n${post.message ?? "(sans texte)"}`,
    schema: z.toJSONSchema(ProductDraft) as Record<string, unknown>,
  });
  const draft = ProductDraft.parse(raw);
  return {
    ...draft,
    description: post.message ?? "",
    images: post.full_picture ? [post.full_picture] : [],
    fbPostIds: [post.id],
    postUrl: post.permalink_url,
  };
}
