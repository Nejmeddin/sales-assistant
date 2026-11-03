import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Bot, CheckCircle2, Circle, Clock, Coins, MessageCircleQuestion, MessagesSquare, ShoppingBag, Users } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { api, type EscalationRow, type Product, type Settings, type Stats } from "../lib/api";
import { formatDate, formatNumber, formatRelative } from "../lib/format";
import { Badge, Card, CardHeader, Loading, PageHeader, cn } from "../components/ui";

function StatCard({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
        <span className="[&>svg]:size-4">{icon}</span>
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{sub}</div>}
    </Card>
  );
}

/**
 * Single-series daily bar chart. Messages and orders have very different scales, so each
 * gets its own chart (small multiples) instead of a shared or dual axis.
 */
function DailyBars({ title, data, accessor }: { title: string; data: Stats["perDay"]; accessor: (d: Stats["perDay"][number]) => number }) {
  const max = Math.max(1, ...data.map(accessor));
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h4 className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{title}</h4>
        <span className="text-xs text-zinc-400 tabular-nums">max {formatNumber(max)}</span>
      </div>
      <div className="relative h-36">
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-zinc-200 dark:border-zinc-800" />
        <div className="absolute inset-x-0 bottom-0 border-t border-zinc-200 dark:border-zinc-700" />
        <div className="flex h-full items-end gap-0.5">
          {data.map((d) => {
            const v = accessor(d);
            return (
              <div key={d.day} className="group relative flex h-full flex-1 items-end justify-center" tabIndex={0} aria-label={`${formatDate(d.day, { weekday: "long", day: "numeric", month: "short" })}: ${v}`}>
                <div className="w-full max-w-7 rounded-t bg-brand-500 transition-colors group-hover:bg-brand-600 group-focus:bg-brand-600" style={{ height: `${Math.max(v ? 3 : 0, (v / max) * 100)}%` }} />
                <div className="pointer-events-none absolute bottom-full z-10 mb-1 hidden rounded-md bg-zinc-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow-lg group-hover:block group-focus:block dark:bg-zinc-100 dark:text-zinc-900">
                  {formatDate(d.day, { weekday: "short", day: "numeric", month: "short" })} · <span className="font-semibold tabular-nums">{v}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex gap-0.5">
        {data.map((d) => (
          <div key={d.day} className="flex-1 text-center text-[11px] text-zinc-400">
            {formatDate(d.day, { weekday: "short" }).replace(".", "")}
          </div>
        ))}
      </div>
    </div>
  );
}

function SetupItem({ done, children, to }: { done: boolean; children: ReactNode; to: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      {done ? <CheckCircle2 className="size-4 text-emerald-500" /> : <Circle className="size-4 text-zinc-300 dark:text-zinc-600" />}
      <span className={cn(done && "text-zinc-500 line-through decoration-zinc-300")}>{children}</span>
    </Link>
  );
}

export default function Overview() {
  const { t } = useTranslation();
  const stats = useQuery({ queryKey: ["stats", 7], queryFn: () => api.get<Stats>("/stats?days=7") });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Settings }>("/settings").then((r) => r.settings) });
  const products = useQuery({ queryKey: ["products"], queryFn: () => api.get<{ products: Product[] }>("/products").then((r) => r.products) });
  const escalations = useQuery({ queryKey: ["escalations", "open"], queryFn: () => api.get<{ escalations: EscalationRow[] }>("/escalations?status=open").then((r) => r.escalations) });

  if (!stats.data) return <Loading />;
  const s = stats.data;
  const totalRuns = s.runs.reduce((a, r) => a + Number(r.n), 0);
  const replied = Number(s.runs.find((r) => r.outcome === "replied")?.n ?? 0);
  const tokens = s.runs.reduce((a, r) => a + Number(r.input ?? 0) + Number(r.output ?? 0), 0);
  const latencies = s.runs.filter((r) => r.latency != null && r.outcome !== "error");
  const avgLatency = latencies.length ? latencies.reduce((a, r) => a + Number(r.latency) * Number(r.n), 0) / latencies.reduce((a, r) => a + Number(r.n), 0) : 0;

  const cfg = settings.data;
  const aiReady = cfg ? Boolean(cfg.ai.provider === "gemini" ? cfg.ai.gemini.apiKey : cfg.ai.anthropic.apiKey) : false;

  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.period")} />
      {cfg && !cfg.bot.enabled && (
        <div className="mb-6 flex items-center gap-2 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30">
          <Bot className="size-4" /> {t("overview.botOff")}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={<MessagesSquare />} label={t("overview.messages")} value={formatNumber(s.inboundMessages)} sub={`${t("overview.conversations")} : ${formatNumber(s.newConversations)}`} />
        <StatCard icon={<ShoppingBag />} label={t("overview.orders")} value={formatNumber(s.orders)} />
        <StatCard
          icon={<Users />}
          label={t("overview.autoRate")}
          value={totalRuns ? `${Math.round((replied / totalRuns) * 100)} %` : "—"}
          sub={`${formatNumber(replied)} / ${formatNumber(totalRuns)}`}
        />
        <StatCard icon={<MessageCircleQuestion />} label={t("overview.openEscalations")} value={formatNumber(s.openEscalations)} sub={s.openEscalations > 0 ? <Link to="/escalations" className="text-brand-600 hover:underline">{t("overview.seeEscalations")} →</Link> : undefined} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title={t("overview.activity")} description={t("overview.period")} />
          <div className="grid gap-8 p-5 sm:grid-cols-2">
            <DailyBars title={t("overview.messages")} data={s.perDay} accessor={(d) => d.messages} />
            <DailyBars title={t("overview.orders")} data={s.perDay} accessor={(d) => d.orders} />
          </div>
          <table className="sr-only">
            <thead>
              <tr>
                <th>Date</th>
                <th>{t("overview.messages")}</th>
                <th>{t("overview.orders")}</th>
              </tr>
            </thead>
            <tbody>
              {s.perDay.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.messages}</td>
                  <td>{d.orders}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="grid grid-cols-2 border-t border-zinc-100 text-sm dark:border-zinc-800">
            <div className="flex items-center gap-2 px-5 py-3 text-zinc-500">
              <Clock className="size-4" /> {t("overview.avgLatency")} : <span className="font-medium text-zinc-900 tabular-nums dark:text-zinc-100">{avgLatency ? `${(avgLatency / 1000).toFixed(1)} s` : "—"}</span>
            </div>
            <div className="flex items-center gap-2 border-l border-zinc-100 px-5 py-3 text-zinc-500 dark:border-zinc-800">
              <Coins className="size-4" /> {t("overview.tokens")} : <span className="font-medium text-zinc-900 tabular-nums dark:text-zinc-100">{formatNumber(tokens, { notation: "compact" })}</span>
            </div>
          </div>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title={t("overview.setupTitle")} />
            <div className="p-3">
              <SetupItem done={aiReady} to="/settings/ai">{t("overview.setupAi")}</SetupItem>
              <SetupItem done={Boolean(cfg?.meta.pages.some((p) => p.accessToken) && cfg.meta.appSecret)} to="/settings/meta">{t("overview.setupMeta")}</SetupItem>
              <SetupItem done={Boolean(cfg && cfg.notifications.transport !== "none" && cfg.notifications.escalationEmails.length)} to="/settings/notifications">{t("overview.setupEmail")}</SetupItem>
              <SetupItem done={Boolean(cfg?.sheets.enabled && cfg.sheets.spreadsheetId)} to="/settings/sheets">{t("overview.setupSheets")}</SetupItem>
              <SetupItem done={Boolean(products.data?.some((p) => p.active))} to="/products">{t("overview.setupProducts")}</SetupItem>
            </div>
          </Card>

          {!!escalations.data?.length && (
            <Card>
              <CardHeader title={t("overview.openEscalations")} action={<Badge tone="red">{escalations.data.length}</Badge>} />
              <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {escalations.data.slice(0, 5).map(({ escalation, contact }) => (
                  <li key={escalation.id}>
                    <Link to={`/escalations/${escalation.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{escalation.question}</div>
                        <div className="text-xs text-zinc-500">
                          {contact.displayName ?? t("inbox.unknownClient")} · {formatRelative(escalation.createdAt)}
                        </div>
                      </div>
                      <ArrowRight className="size-4 text-zinc-400" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
