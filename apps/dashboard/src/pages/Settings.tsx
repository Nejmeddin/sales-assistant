import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Copy, Plus, Trash2, XCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { Button, Card, Field, Input, Loading, PageHeader, Select, Switch, Tabs, Textarea } from "../components/ui";
import { api, type Settings, type SettingsKey, type TestResult } from "../lib/api";

const TABS: SettingsKey[] = ["ai", "bot", "meta", "notifications", "sheets", "sources"];
const TEST_TARGET: Partial<Record<SettingsKey, string>> = { ai: "ai", meta: "meta", notifications: "email", sheets: "sheets" };

/** Secrets come back masked ("••••1234"): select-all on focus so typing replaces them. */
function SecretInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <Input type="text" autoComplete="off" spellCheck={false} value={value} placeholder={placeholder} onFocus={(e) => value.startsWith("••••") && e.target.select()} onChange={(e) => onChange(e.target.value)} className="font-mono" />;
}

function Section({ children }: { children: ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2">{children}</div>;
}

function AiForm({ v, set }: { v: Settings["ai"]; set: (v: Settings["ai"]) => void }) {
  const { t } = useTranslation();
  return (
    <Section>
      <Field label={t("settings.ai.provider")}>
        <Select value={v.provider} onChange={(e) => set({ ...v, provider: e.target.value as Settings["ai"]["provider"] })}>
          <option value="gemini">Google Gemini</option>
          <option value="anthropic">Anthropic Claude</option>
        </Select>
      </Field>
      <Field label={t("settings.ai.fallback")}>
        <Select value={v.fallbackProvider} onChange={(e) => set({ ...v, fallbackProvider: e.target.value as Settings["ai"]["fallbackProvider"] })}>
          <option value="none">{t("settings.ai.none")}</option>
          <option value="gemini">Google Gemini</option>
          <option value="anthropic">Anthropic Claude</option>
        </Select>
      </Field>
      <Field label={t("settings.ai.geminiKey")} hint={<a className="text-brand-600 hover:underline" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">{t("settings.ai.geminiHint")}</a>}>
        <SecretInput value={v.gemini.apiKey} onChange={(apiKey) => set({ ...v, gemini: { ...v.gemini, apiKey } })} placeholder="AIza…" />
      </Field>
      <Field label={`${t("settings.ai.model")} (Gemini)`}>
        <Input value={v.gemini.model} onChange={(e) => set({ ...v, gemini: { ...v.gemini, model: e.target.value } })} list="gemini-models" />
      </Field>
      <Field label={t("settings.ai.anthropicKey")} hint={<a className="text-brand-600 hover:underline" href="https://console.anthropic.com/" target="_blank" rel="noreferrer">{t("settings.ai.anthropicHint")}</a>}>
        <SecretInput value={v.anthropic.apiKey} onChange={(apiKey) => set({ ...v, anthropic: { ...v.anthropic, apiKey } })} placeholder="sk-ant-…" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`${t("settings.ai.model")} (Claude)`}>
          <Input value={v.anthropic.model} onChange={(e) => set({ ...v, anthropic: { ...v.anthropic, model: e.target.value } })} />
        </Field>
        <Field label={t("settings.ai.effort")}>
          <Select value={v.anthropic.effort} onChange={(e) => set({ ...v, anthropic: { ...v.anthropic, effort: e.target.value as "low" } })}>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </Select>
        </Field>
      </div>
      <Field label={t("settings.ai.maxSteps")}>
        <Input type="number" min={1} max={12} value={v.maxToolSteps} onChange={(e) => set({ ...v, maxToolSteps: Number(e.target.value) })} />
      </Field>
      <Field label={t("settings.ai.history")}>
        <Input type="number" min={4} max={100} value={v.historyLimit} onChange={(e) => set({ ...v, historyLimit: Number(e.target.value) })} />
      </Field>
    </Section>
  );
}

function BotForm({ v, set }: { v: Settings["bot"]; set: (v: Settings["bot"]) => void }) {
  const { t } = useTranslation();
  const toggleField = (f: Settings["bot"]["requiredOrderFields"][number]) =>
    set({ ...v, requiredOrderFields: v.requiredOrderFields.includes(f) ? v.requiredOrderFields.filter((x) => x !== f) : [...v.requiredOrderFields, f] });
  return (
    <div className="space-y-5">
      <Switch checked={v.enabled} onChange={(enabled) => set({ ...v, enabled })} label={t("settings.bot.enabled")} description={t("settings.bot.enabledHint")} />
      <Section>
        <Field label={t("settings.bot.businessName")}>
          <Input value={v.businessName} onChange={(e) => set({ ...v, businessName: e.target.value })} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label={t("settings.bot.defaultLanguage")}>
            <Input value={v.defaultLanguage} onChange={(e) => set({ ...v, defaultLanguage: e.target.value })} />
          </Field>
          <Field label={t("settings.bot.currency")}>
            <Input value={v.currency} onChange={(e) => set({ ...v, currency: e.target.value.toUpperCase() })} />
          </Field>
          <Field label={t("settings.bot.phoneCountry")}>
            <Input maxLength={2} value={v.phoneCountry} onChange={(e) => set({ ...v, phoneCountry: e.target.value.toUpperCase() })} />
          </Field>
        </div>
      </Section>
      <Field label={t("settings.bot.persona")}>
        <Textarea rows={3} value={v.persona} onChange={(e) => set({ ...v, persona: e.target.value })} />
      </Field>
      <Switch checked={v.cashOnDelivery} onChange={(cashOnDelivery) => set({ ...v, cashOnDelivery })} label={t("settings.bot.cod")} />
      <Field label={t("settings.bot.policies")} hint={t("settings.bot.policiesHint")}>
        <Textarea rows={4} value={v.policies} onChange={(e) => set({ ...v, policies: e.target.value })} placeholder="Livraison 7 TND partout en Tunisie, 24 à 72 h…" />
      </Field>
      <Field label={t("settings.bot.escalationMessage")}>
        <Input value={v.escalationMessage} onChange={(e) => set({ ...v, escalationMessage: e.target.value })} />
      </Field>
      <Field label={t("settings.bot.required")}>
        <div className="flex flex-wrap gap-4 pt-1">
          {(["customerName", "phone", "city"] as const).map((f) => (
            <label key={f} className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-brand-600" checked={v.requiredOrderFields.includes(f)} onChange={() => toggleField(f)} />
              {t(`settings.bot.field_${f}`)}
            </label>
          ))}
        </div>
      </Field>
      <Section>
        <Field label={t("settings.bot.debounce")} hint={t("settings.bot.debounceHint")}>
          <Input type="number" min={0} max={30000} step={500} value={v.debounceMs} onChange={(e) => set({ ...v, debounceMs: Number(e.target.value) })} />
        </Field>
        <Field label={t("settings.bot.pause")}>
          <Input type="number" min={0} value={v.humanTakeoverPauseMinutes} onChange={(e) => set({ ...v, humanTakeoverPauseMinutes: Number(e.target.value) })} />
        </Field>
      </Section>
    </div>
  );
}

function MetaForm({ v, set, webhookUrl }: { v: Settings["meta"]; set: (v: Settings["meta"]) => void; webhookUrl: string }) {
  const { t } = useTranslation();
  const page = (i: number, patch: Partial<Settings["meta"]["pages"][number]>) => set({ ...v, pages: v.pages.map((p, j) => (i === j ? { ...p, ...patch } : p)) });
  return (
    <div className="space-y-6">
      <Field label={t("settings.meta.webhook")} hint={t("settings.meta.webhookHint")}>
        <div className="flex gap-2">
          <Input readOnly value={webhookUrl} className="font-mono" />
          <Button
            variant="secondary"
            onClick={() => {
              void navigator.clipboard.writeText(webhookUrl);
              toast.success(t("common.copied"));
            }}
          >
            <Copy className="size-4" /> {t("common.copy")}
          </Button>
        </div>
      </Field>
      <Section>
        <Field label={t("settings.meta.appId")}>
          <Input value={v.appId} onChange={(e) => set({ ...v, appId: e.target.value })} />
        </Field>
        <Field label={t("settings.meta.appSecret")}>
          <SecretInput value={v.appSecret} onChange={(appSecret) => set({ ...v, appSecret })} />
        </Field>
        <Field label={t("settings.meta.verifyToken")} hint={t("settings.meta.verifyHint")}>
          <Input value={v.verifyToken} onChange={(e) => set({ ...v, verifyToken: e.target.value })} />
        </Field>
        <Field label={t("settings.meta.graphVersion")}>
          <Input value={v.graphVersion} onChange={(e) => set({ ...v, graphVersion: e.target.value })} />
        </Field>
      </Section>
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h4 className="text-sm font-semibold">{t("settings.meta.pages")}</h4>
          <Button variant="secondary" size="sm" onClick={() => set({ ...v, pages: [...v.pages, { pageId: "", name: "", accessToken: "", instagramId: "", enabled: true }] })}>
            <Plus className="size-3.5" /> {t("settings.meta.addPage")}
          </Button>
        </div>
        <div className="space-y-3">
          {v.pages.map((p, i) => (
            <div key={i} className="space-y-4 rounded-lg p-4 ring-1 ring-zinc-200 dark:ring-zinc-800">
              <div className="flex items-center justify-between">
                <Switch checked={p.enabled} onChange={(enabled) => page(i, { enabled })} label={p.name || p.pageId || "—"} />
                <Button variant="ghost" size="sm" onClick={() => set({ ...v, pages: v.pages.filter((_, j) => j !== i) })} aria-label={t("common.delete")}>
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
              <Section>
                <Field label={t("settings.meta.pageId")}>
                  <Input value={p.pageId} onChange={(e) => page(i, { pageId: e.target.value.trim() })} />
                </Field>
                <Field label={t("settings.meta.pageName")}>
                  <Input value={p.name} onChange={(e) => page(i, { name: e.target.value })} />
                </Field>
                <Field label={t("settings.meta.token")}>
                  <SecretInput value={p.accessToken} onChange={(accessToken) => page(i, { accessToken })} placeholder="EAA…" />
                </Field>
                <Field label={t("settings.meta.instagramId")}>
                  <Input value={p.instagramId} onChange={(e) => page(i, { instagramId: e.target.value.trim() })} placeholder="1784…" />
                </Field>
              </Section>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function NotificationsForm({ v, set }: { v: Settings["notifications"]; set: (v: Settings["notifications"]) => void }) {
  const { t } = useTranslation();
  const [emails, setEmails] = useState(v.escalationEmails.join("\n"));
  return (
    <div className="space-y-5">
      <Field label={t("settings.notifications.emails")} hint={t("settings.notifications.emailsHint")}>
        <Textarea
          rows={3}
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          onBlur={() => set({ ...v, escalationEmails: emails.split(/[\n,;]/).map((x) => x.trim()).filter(Boolean) })}
          placeholder="vous@exemple.com"
        />
      </Field>
      <Field label={t("settings.notifications.transport")}>
        <Select value={v.transport} onChange={(e) => set({ ...v, transport: e.target.value as Settings["notifications"]["transport"] })} className="max-w-xs">
          <option value="none">{t("settings.notifications.transport_none")}</option>
          <option value="smtp">{t("settings.notifications.transport_smtp")}</option>
          <option value="resend">{t("settings.notifications.transport_resend")}</option>
        </Select>
      </Field>
      {v.transport === "smtp" && (
        <>
          <p className="text-xs text-zinc-500">{t("settings.notifications.gmailHint")}</p>
          <Section>
            <Field label={t("settings.notifications.host")}>
              <Input value={v.smtp.host} onChange={(e) => set({ ...v, smtp: { ...v.smtp, host: e.target.value } })} />
            </Field>
            <div className="grid grid-cols-2 items-end gap-3">
              <Field label={t("settings.notifications.port")}>
                <Input type="number" value={v.smtp.port} onChange={(e) => set({ ...v, smtp: { ...v.smtp, port: Number(e.target.value) } })} />
              </Field>
              <div className="pb-2">
                <Switch checked={v.smtp.secure} onChange={(secure) => set({ ...v, smtp: { ...v.smtp, secure } })} label={t("settings.notifications.secure")} />
              </div>
            </div>
            <Field label={t("settings.notifications.user")}>
              <Input value={v.smtp.user} onChange={(e) => set({ ...v, smtp: { ...v.smtp, user: e.target.value } })} placeholder="boutique.bot@gmail.com" />
            </Field>
            <Field label={t("settings.notifications.pass")}>
              <SecretInput value={v.smtp.pass} onChange={(pass) => set({ ...v, smtp: { ...v.smtp, pass } })} />
            </Field>
            <Field label={t("settings.notifications.from")}>
              <Input value={v.smtp.from} onChange={(e) => set({ ...v, smtp: { ...v.smtp, from: e.target.value } })} placeholder="Africa Smile Bot <boutique.bot@gmail.com>" />
            </Field>
          </Section>
        </>
      )}
      {v.transport === "resend" && (
        <Section>
          <Field label={t("settings.notifications.resendKey")}>
            <SecretInput value={v.resend.apiKey} onChange={(apiKey) => set({ ...v, resend: { ...v.resend, apiKey } })} placeholder="re_…" />
          </Field>
          <Field label={t("settings.notifications.from")}>
            <Input value={v.resend.from} onChange={(e) => set({ ...v, resend: { ...v.resend, from: e.target.value } })} />
          </Field>
        </Section>
      )}
      <p className="text-xs text-zinc-500">{t("settings.notifications.testHint")}</p>
    </div>
  );
}

function SheetsForm({ v, set }: { v: Settings["sheets"]; set: (v: Settings["sheets"]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <Switch checked={v.enabled} onChange={(enabled) => set({ ...v, enabled })} label={t("settings.sheets.enabled")} />
      <Field label={t("settings.sheets.spreadsheetId")} hint={t("settings.sheets.spreadsheetHint")}>
        <Input value={v.spreadsheetId} onChange={(e) => set({ ...v, spreadsheetId: e.target.value.trim() })} className="font-mono" />
      </Field>
      <Field label={t("settings.sheets.serviceAccount")} hint={t("settings.sheets.serviceAccountHint")}>
        {v.serviceAccountJson.startsWith("••••") ? (
          <div className="flex gap-2">
            <Input readOnly value={v.serviceAccountJson} className="font-mono" />
            <Button variant="secondary" onClick={() => set({ ...v, serviceAccountJson: "" })}>
              {t("common.edit")}
            </Button>
          </div>
        ) : (
          <Textarea rows={5} className="font-mono text-xs" value={v.serviceAccountJson} onChange={(e) => set({ ...v, serviceAccountJson: e.target.value })} placeholder='{ "type": "service_account", "client_email": "…", "private_key": "…" }' />
        )}
      </Field>
      <Section>
        <Field label={t("settings.sheets.tabFormat")}>
          <Input value={v.tabNameFormat} onChange={(e) => set({ ...v, tabNameFormat: e.target.value })} />
        </Field>
        <Field label={t("settings.sheets.timezone")}>
          <Input value={v.timezone} onChange={(e) => set({ ...v, timezone: e.target.value })} />
        </Field>
      </Section>
    </div>
  );
}

function SourcesForm({ v, set }: { v: Settings["sources"]; set: (v: Settings["sources"]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-5">
      <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-700 dark:bg-brand-700/20 dark:text-brand-100">{t("settings.sources.soon")}</p>
      <Field label={t("settings.sources.serpApiKey")} hint={t("settings.sources.serpHint")}>
        <SecretInput value={v.serpApiKey} onChange={(serpApiKey) => set({ ...v, serpApiKey })} />
      </Field>
      <Field label={t("settings.sources.sites")}>
        <Input value={v.sites.join(", ")} onChange={(e) => set({ ...v, sites: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
      </Field>
      <Switch checked={v.extractSpecs} onChange={(extractSpecs) => set({ ...v, extractSpecs })} label={t("settings.sources.extract")} />
    </div>
  );
}

function TestResultView({ result }: { result: TestResult }) {
  const Icon = result.ok ? CheckCircle2 : XCircle;
  return (
    <div className={`mt-4 rounded-lg px-3 py-2 text-sm ${result.ok ? "bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200" : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"}`}>
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0" />
        <div className="space-y-1">
          <div>{result.detail ?? result.error}</div>
          {result.pages?.map((p) => (
            <div key={p.pageId} className="text-xs">
              {p.ok ? "✓" : "✗"} {p.name ?? p.pageId} {p.error && `— ${p.error}`}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { tab: tabParam } = useParams();
  const tab: SettingsKey = TABS.includes(tabParam as SettingsKey) ? (tabParam as SettingsKey) : "ai";
  const { data } = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Settings; webhookUrl: string }>("/settings") });
  const [draft, setDraft] = useState<Settings>();
  const [result, setResult] = useState<TestResult>();

  useEffect(() => {
    if (data) setDraft(structuredClone(data.settings));
  }, [data]);
  useEffect(() => setResult(undefined), [tab]);

  const save = useMutation({
    mutationFn: () => api.put<{ settings: Settings[SettingsKey] }>(`/settings/${tab}`, draft![tab]),
    onSuccess: async () => {
      toast.success(t("common.saved"));
      await qc.invalidateQueries({ queryKey: ["settings"] });
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      await save.mutateAsync();
      return api.post<TestResult>(`/settings/test/${TEST_TARGET[tab]}`);
    },
    onSuccess: setResult,
  });

  if (!draft || !data) return <Loading />;
  const set = <K extends SettingsKey>(k: K) => (v: Settings[K]) => setDraft({ ...draft, [k]: v });

  return (
    <>
      <PageHeader title={t("settings.title")} />
      <div className="mb-5">
        <Tabs value={tab} onChange={(v) => navigate(`/settings/${v}`)} items={TABS.map((k) => ({ value: k, label: t(`settings.tabs.${k}`) }))} />
      </div>
      <Card className="p-6">
        {tab === "ai" && <AiForm v={draft.ai} set={set("ai")} />}
        {tab === "bot" && <BotForm v={draft.bot} set={set("bot")} />}
        {tab === "meta" && <MetaForm v={draft.meta} set={set("meta")} webhookUrl={data.webhookUrl} />}
        {tab === "notifications" && <NotificationsForm key={data.settings.notifications.escalationEmails.join()} v={draft.notifications} set={set("notifications")} />}
        {tab === "sheets" && <SheetsForm v={draft.sheets} set={set("sheets")} />}
        {tab === "sources" && <SourcesForm v={draft.sources} set={set("sources")} />}

        {result && <TestResultView result={result} />}
        {tab === "ai" && result?.models && result.models.length > 0 && (
          <datalist id="gemini-models">
            {result.models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        )}

        <div className="mt-6 flex justify-end gap-2 border-t border-zinc-100 pt-5 dark:border-zinc-800">
          {TEST_TARGET[tab] && (
            <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending}>
              {test.isPending ? t("common.testing") : t("common.test")}
            </Button>
          )}
          <Button onClick={() => save.mutate()} loading={save.isPending && !test.isPending}>
            {t("common.save")}
          </Button>
        </div>
      </Card>
    </>
  );
}
