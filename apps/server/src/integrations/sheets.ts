import { JWT } from "google-auth-library";
import { z } from "zod";

const ServiceAccount = z.object({ client_email: z.string().email(), private_key: z.string().min(1) });

export const ORDER_COLUMNS = [
  "Heure",
  "Nom",
  "Téléphone",
  "Ville",
  "Adresse",
  "Produit",
  "Options",
  "Quantité",
  "Prix unitaire",
  "Canal",
  "Notes",
  "Conversation",
  "ID commande",
] as const;

/** Formats `date` in `timeZone` using YYYY / MM / DD / HH / mm tokens. */
export function formatInZone(date: Date, timeZone: string, pattern: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return pattern
    .replace("YYYY", parts.year!)
    .replace("MM", parts.month!)
    .replace("DD", parts.day!)
    .replace("HH", parts.hour!)
    .replace("mm", parts.minute!);
}

export interface SheetsWriter {
  /** Appends a row to the tab, creating the tab (with header) if needed. */
  appendRow(tab: string, row: (string | number)[]): Promise<void>;
}

/** Google Sheets REST v4 with a service account — no heavy `googleapis` dependency. */
export class GoogleSheetsWriter implements SheetsWriter {
  private readonly auth: JWT;
  private readonly knownTabs = new Set<string>();

  constructor(
    private readonly spreadsheetId: string,
    serviceAccountJson: string,
  ) {
    const sa = ServiceAccount.parse(JSON.parse(serviceAccountJson));
    this.auth = new JWT({ email: sa.client_email, key: sa.private_key, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  }

  private async request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const { token } = await this.auth.getAccessToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${this.spreadsheetId}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`Google Sheets ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  private async ensureTab(tab: string): Promise<void> {
    if (this.knownTabs.has(tab)) return;
    const meta = await this.request<{ sheets: { properties: { title: string } }[] }>("?fields=sheets.properties.title");
    if (!meta.sheets.some((s) => s.properties.title === tab)) {
      await this.request(":batchUpdate", {
        method: "POST",
        body: {
          requests: [{ addSheet: { properties: { title: tab, gridProperties: { frozenRowCount: 1 } } } }],
        },
      });
      await this.request(`/values/${encodeURIComponent(`'${tab}'!A1`)}?valueInputOption=RAW`, {
        method: "PUT",
        body: { values: [ORDER_COLUMNS] },
      });
    }
    this.knownTabs.add(tab);
  }

  async appendRow(tab: string, row: (string | number)[]): Promise<void> {
    await this.ensureTab(tab);
    await this.request(`/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: { values: [row] },
    });
  }

  /** Dashboard "test connection". */
  async check(): Promise<{ title: string }> {
    const res = await this.request<{ properties: { title: string } }>("?fields=properties.title");
    return { title: res.properties.title };
  }
}

export type SheetsFactory = (spreadsheetId: string, serviceAccountJson: string) => SheetsWriter;
export const createSheetsWriter: SheetsFactory = (id, json) => new GoogleSheetsWriter(id, json);
