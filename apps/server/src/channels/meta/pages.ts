import type { Settings } from "../../settings/schema.js";
import type { MetaPageCredentials } from "./client.js";

export function findPage(meta: Settings["meta"], pageId: string) {
  return meta.pages.find((p) => p.pageId === pageId && p.enabled);
}

export function pageCredentials(meta: Settings["meta"], pageId: string): MetaPageCredentials {
  const page = findPage(meta, pageId);
  if (!page?.accessToken) throw new Error(`No access token configured for page ${pageId}`);
  return { pageId: page.pageId, accessToken: page.accessToken };
}

export function pageIdForInstagram(meta: Settings["meta"], instagramId: string): string | undefined {
  return meta.pages.find((p) => p.instagramId === instagramId && p.enabled)?.pageId;
}
