import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, RefreshCw, ShoppingBag } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { toast } from "sonner";
import { ChannelBadge } from "../components/ChannelBadge";
import { Badge, Button, Card, EmptyState, Loading, PageHeader, Table, Tabs, Td, type Tone } from "../components/ui";
import { api, type Order, type OrderRow } from "../lib/api";
import { formatDate, formatPrice } from "../lib/format";

type Filter = "all" | "synced" | "submitted" | "sync_failed";
const tone: Record<Order["status"], Tone> = { draft: "neutral", submitted: "amber", synced: "green", sync_failed: "red" };

function toCsv(rows: OrderRow[]): string {
  const header = ["date", "name", "phone", "city", "address", "product", "options", "quantity", "price", "channel", "status"];
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map(({ order: o, productName, price, channel }) =>
    [o.submittedAt ?? o.createdAt, o.customerName, o.phone, o.city, o.address, productName, Object.entries(o.options).map(([k, v]) => `${k}: ${v}`).join("; "), o.quantity, price, channel, o.status]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export default function Orders() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isLoading } = useQuery({
    queryKey: ["orders", filter],
    queryFn: () => api.get<{ orders: OrderRow[] }>(`/orders${filter === "all" ? "" : `?status=${filter}`}`).then((r) => r.orders),
    refetchInterval: 20_000,
  });
  const resync = useMutation({
    mutationFn: (id: string) => api.post(`/orders/${id}/resync`),
    onSuccess: async () => {
      toast.success(t("orders.resynced"));
      await qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(new Blob(["﻿" + toCsv(data)], { type: "text/csv;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `orders-${new Date().toISOString().slice(0, 10)}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title={t("orders.title")}
        actions={
          <>
            <Tabs
              value={filter}
              onChange={setFilter}
              items={[
                { value: "all", label: t("common.all") },
                { value: "synced", label: t("orders.status_synced") },
                { value: "submitted", label: t("orders.status_submitted") },
                { value: "sync_failed", label: t("orders.status_sync_failed") },
              ]}
            />
            <Button variant="secondary" onClick={download} disabled={!data?.length}>
              <Download className="size-4" /> {t("orders.exportCsv")}
            </Button>
          </>
        }
      />
      <Card>
        {isLoading && <Loading />}
        {data?.length === 0 && <EmptyState icon={<ShoppingBag className="size-5" />}>{t("common.empty")}</EmptyState>}
        {!!data?.length && (
          <Table head={[t("orders.date"), t("orders.customer"), t("orders.phone"), t("orders.city"), t("orders.product"), t("orders.options"), t("orders.qty"), t("orders.status"), ""]}>
            {data.map(({ order: o, productName, price, currency, channel }) => (
              <tr key={o.id} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30">
                <Td className="whitespace-nowrap text-zinc-500">{formatDate(o.submittedAt ?? o.createdAt, { dateStyle: "short", timeStyle: "short" })}</Td>
                <Td>
                  <Link to={`/conversations/${o.conversationId}`} className="font-medium hover:underline">
                    {o.customerName ?? "—"}
                  </Link>
                  <div className="mt-1">
                    <ChannelBadge channel={channel} />
                  </div>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">
                  {o.phone ? (
                    <a href={`tel:${o.phone}`} className="hover:underline">
                      {o.phone}
                    </a>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  {o.city ?? "—"}
                  {o.address && <div className="text-xs text-zinc-500">{o.address}</div>}
                </Td>
                <Td>
                  {productName ?? "—"}
                  <div className="text-xs text-zinc-500">{formatPrice(price, currency ?? undefined)}</div>
                </Td>
                <Td className="text-zinc-600 dark:text-zinc-300">{Object.entries(o.options).map(([k, v]) => `${k}: ${v}`).join(", ") || "—"}</Td>
                <Td className="tabular-nums">{o.quantity}</Td>
                <Td>
                  <Badge tone={tone[o.status]}>{t(`orders.status_${o.status}`)}</Badge>
                  {o.sheetTab && <div className="mt-1 text-xs text-zinc-500">{o.sheetTab}</div>}
                  {o.syncError && <div className="mt-1 max-w-48 truncate text-xs text-red-600" title={o.syncError}>{o.syncError}</div>}
                </Td>
                <Td>
                  {o.status !== "synced" && (
                    <Button variant="ghost" size="sm" onClick={() => resync.mutate(o.id)} title={t("orders.resync")}>
                      <RefreshCw className="size-3.5" />
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
