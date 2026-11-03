import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, ExternalLink, Package, Pencil, Plus, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Badge, Button, Card, Drawer, EmptyState, Field, Input, Loading, PageHeader, Select, Switch, Table, Td, Textarea, type Tone } from "../components/ui";
import { api, type Product, type ProductDraft, type ProductInput, type Settings, type Variant } from "../lib/api";
import { formatPrice, joinList, splitList } from "../lib/format";

const emptyProduct: ProductInput = {
  name: "",
  description: "",
  price: null,
  currency: "TND",
  variants: [],
  inStock: null,
  active: true,
  images: [],
  keywords: [],
  fbPostIds: [],
  adIds: [],
  igMediaIds: [],
  storeUrl: null,
  sourceUrl: null,
};

const sourceTone: Record<Product["sourceStatus"], Tone> = { none: "neutral", linked: "brand", searching: "amber", matched: "green", not_found: "red" };

/** Comma-separated list input that keeps the raw text while typing. */
function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(joinList(value));
  return <Input value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(splitList(text))} />;
}

function VariantsEditor({ value, onChange }: { value: Variant[]; onChange: (v: Variant[]) => void }) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<Variant>) => onChange(value.map((v, j) => (i === j ? { ...v, ...patch } : v)));
  return (
    <div className="space-y-2">
      {value.map((v, i) => (
        <div key={i} className="flex gap-2">
          <Input className="w-40" placeholder={t("products.variantName")} value={v.name} onChange={(e) => update(i, { name: e.target.value })} />
          <ListInput value={v.options} onChange={(options) => update(i, { options })} placeholder={t("products.variantOptions")} />
          <Button variant="ghost" size="icon" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={t("common.delete")}>
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => onChange([...value, { name: "", options: [] }])}>
        <Plus className="size-3.5" /> {t("products.addVariant")}
      </Button>
    </div>
  );
}

function ProductForm({ initial, onSaved, onCancel, id }: { initial: ProductInput; id?: string; onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [p, setP] = useState<ProductInput>(initial);
  const set = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) => setP((prev) => ({ ...prev, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...p, variants: p.variants.filter((v) => v.name && v.options.length), storeUrl: p.storeUrl || null, sourceUrl: p.sourceUrl || null };
      return id ? api.patch(`/products/${id}`, body) : api.post("/products", body);
    },
    onSuccess: () => {
      toast.success(t("common.saved"));
      onSaved();
    },
  });
  const stock = p.inStock === null ? "unknown" : p.inStock ? "in" : "out";

  return (
    <Drawer
      open
      wide
      onClose={onCancel}
      title={id ? p.name : t("products.new")}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!p.name.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_140px_100px]">
          <Field label={t("products.name")}>
            <Input value={p.name} onChange={(e) => set("name", e.target.value)} autoFocus />
          </Field>
          <Field label={t("products.price")}>
            <Input type="number" min={0} step="0.001" value={p.price ?? ""} onChange={(e) => set("price", e.target.value === "" ? null : Number(e.target.value))} />
          </Field>
          <Field label={t("products.currency")}>
            <Input value={p.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
          </Field>
        </div>
        <Field label={t("products.description")}>
          <Textarea rows={6} value={p.description} onChange={(e) => set("description", e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("products.stock")}>
            <Select value={stock} onChange={(e) => set("inStock", e.target.value === "unknown" ? null : e.target.value === "in")}>
              <option value="unknown">{t("products.stockUnknown")}</option>
              <option value="in">{t("products.stockIn")}</option>
              <option value="out">{t("products.stockOut")}</option>
            </Select>
          </Field>
          <div className="pt-7">
            <Switch checked={p.active} onChange={(v) => set("active", v)} label={t("products.active")} />
          </div>
        </div>
        <Field label={t("products.variants")}>
          <VariantsEditor value={p.variants} onChange={(v) => set("variants", v)} />
        </Field>
        <Field label={t("products.keywords")} hint={t("products.keywordsHint")}>
          <ListInput value={p.keywords} onChange={(v) => set("keywords", v)} />
        </Field>
        <Field label={t("products.images")}>
          <ListInput value={p.images} onChange={(v) => set("images", v)} placeholder="https://…" />
        </Field>

        <fieldset className="space-y-4 rounded-lg p-4 ring-1 ring-zinc-200 dark:ring-zinc-800">
          <legend className="px-1 text-sm font-medium">{t("products.links")}</legend>
          <p className="text-xs text-zinc-500">{t("products.idsHint")}</p>
          <Field label={t("products.fbPostIds")}>
            <ListInput value={p.fbPostIds} onChange={(v) => set("fbPostIds", v)} placeholder="138276736030527_1234567890" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("products.adIds")}>
              <ListInput value={p.adIds} onChange={(v) => set("adIds", v)} />
            </Field>
            <Field label={t("products.igMediaIds")}>
              <ListInput value={p.igMediaIds} onChange={(v) => set("igMediaIds", v)} />
            </Field>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("products.storeUrl")}>
            <Input type="url" value={p.storeUrl ?? ""} onChange={(e) => set("storeUrl", e.target.value)} placeholder="https://….youcan.shop/…" />
          </Field>
          <Field label={t("products.sourceUrl")} hint={t("products.sourceHint")}>
            <Input type="url" value={p.sourceUrl ?? ""} onChange={(e) => set("sourceUrl", e.target.value)} placeholder="https://www.aliexpress.com/item/…" />
          </Field>
        </div>
      </div>
    </Drawer>
  );
}

function ImportDrawer({ onClose, onPick }: { onClose: () => void; onPick: (d: ProductInput) => void }) {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api.get<{ settings: Settings }>("/settings").then((r) => r.settings) });
  const pages = settings.data?.meta.pages ?? [];
  const [pageId, setPageId] = useState("");
  const run = useMutation({ mutationFn: () => api.post<{ drafts: ProductDraft[] }>("/products/import-posts", { pageId: pageId || pages[0]?.pageId, limit: 15 }).then((r) => r.drafts) });

  return (
    <Drawer open wide onClose={onClose} title={t("products.importTitle")}>
      <p className="mb-4 text-sm text-zinc-500">{t("products.importHint")}</p>
      <div className="mb-5 flex gap-2">
        <Select value={pageId || pages[0]?.pageId || ""} onChange={(e) => setPageId(e.target.value)} className="max-w-xs">
          {pages.map((p) => (
            <option key={p.pageId} value={p.pageId}>
              {p.name || p.pageId}
            </option>
          ))}
        </Select>
        <Button onClick={() => run.mutate()} loading={run.isPending} disabled={!pages.length}>
          <Download className="size-4" /> {t("products.importRun")}
        </Button>
      </div>
      {run.data?.length === 0 && <EmptyState>{t("products.importNone")}</EmptyState>}
      <div className="space-y-3">
        {run.data?.map((d, i) => (
          <Card key={i} className="p-4">
            {d.error ? (
              <p className="text-sm text-red-600">{d.error}</p>
            ) : (
              <div className="flex gap-4">
                {d.images?.[0] && <img src={d.images[0]} alt="" className="size-20 shrink-0 rounded-lg object-cover" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.name}</span>
                    <span className="text-sm text-zinc-500">{formatPrice(d.price, d.currency)}</span>
                    {d.isProduct === false && <Badge tone="amber">{t("products.notProduct")}</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{d.description}</p>
                  {!!d.variants?.length && <p className="mt-1 text-xs">{d.variants.map((v) => `${v.name}: ${v.options.join("/")}`).join(" · ")}</p>}
                </div>
                <Button size="sm" variant="secondary" onClick={() => onPick({ ...emptyProduct, ...d } as ProductInput)}>
                  <Plus className="size-3.5" /> {t("products.importAdd")}
                </Button>
              </div>
            )}
          </Card>
        ))}
      </div>
    </Drawer>
  );
}

export default function Products() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<{ id?: string; initial: ProductInput } | null>(null);
  const [importing, setImporting] = useState(false);
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["products"], queryFn: () => api.get<{ products: Product[] }>("/products").then((r) => r.products) });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/products/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
  const filtered = useMemo(() => data?.filter((p) => !q || `${p.name} ${p.keywords.join(" ")}`.toLowerCase().includes(q.toLowerCase())), [data, q]);
  const saved = async () => {
    setEditing(null);
    await qc.invalidateQueries({ queryKey: ["products"] });
  };

  return (
    <>
      <PageHeader
        title={t("products.title")}
        description={t("products.subtitle")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setImporting(true)}>
              <Download className="size-4" /> {t("products.import")}
            </Button>
            <Button onClick={() => setEditing({ initial: emptyProduct })}>
              <Plus className="size-4" /> {t("products.new")}
            </Button>
          </>
        }
      />
      <Card>
        <div className="border-b border-zinc-100 p-3 dark:border-zinc-800">
          <Input className="max-w-xs" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {isLoading && <Loading />}
        {filtered?.length === 0 && <EmptyState icon={<Package className="size-5" />}>{t("common.empty")}</EmptyState>}
        {!!filtered?.length && (
          <Table head={[t("products.name"), t("products.price"), t("products.stock"), t("products.variants"), t("products.sourceUrl"), ""]}>
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-zinc-50/60 dark:hover:bg-zinc-800/30">
                <Td>
                  <div className="flex items-center gap-3">
                    {p.images[0] ? <img src={p.images[0]} alt="" className="size-10 rounded-lg object-cover" /> : <div className="grid size-10 place-items-center rounded-lg bg-zinc-100 dark:bg-zinc-800"><Package className="size-4 text-zinc-400" /></div>}
                    <div>
                      <div className="font-medium">{p.name}</div>
                      {!p.active && <Badge className="mt-0.5">{t("common.no")} · {t("products.active")}</Badge>}
                    </div>
                  </div>
                </Td>
                <Td className="whitespace-nowrap tabular-nums">{formatPrice(p.price, p.currency)}</Td>
                <Td>
                  {p.inStock === false ? <Badge tone="red">{t("products.stockOut")}</Badge> : <Badge tone="green">{p.inStock ? t("products.stockIn") : t("products.stockUnknown")}</Badge>}
                </Td>
                <Td className="text-xs text-zinc-600 dark:text-zinc-300">{p.variants.map((v) => `${v.name}: ${v.options.join("/")}`).join(" · ") || "—"}</Td>
                <Td>
                  <div className="flex items-center gap-1.5">
                    <Badge tone={sourceTone[p.sourceStatus]}>{t(`products.source_${p.sourceStatus}`)}</Badge>
                    {p.sourceUrl && (
                      <a href={p.sourceUrl} target="_blank" rel="noreferrer" className="text-zinc-400 hover:text-zinc-700">
                        <ExternalLink className="size-3.5" />
                      </a>
                    )}
                  </div>
                </Td>
                <Td className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => setEditing({ id: p.id, initial: p })} aria-label={t("common.edit")}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => confirm(t("common.confirmDelete")) && remove.mutate(p.id)} aria-label={t("common.delete")}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {importing && (
        <ImportDrawer
          onClose={() => setImporting(false)}
          onPick={(d) => {
            setImporting(false);
            setEditing({ initial: d });
          }}
        />
      )}
      {editing && <ProductForm key={editing.id ?? "new"} id={editing.id} initial={editing.initial} onSaved={saved} onCancel={() => setEditing(null)} />}
    </>
  );
}
