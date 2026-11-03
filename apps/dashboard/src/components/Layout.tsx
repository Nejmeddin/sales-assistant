import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Inbox, LayoutDashboard, LogOut, Menu, MessageCircleQuestion, Moon, Package, Settings, ShoppingBag, Sun, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import { LANGUAGES } from "../i18n";
import { api, type Stats } from "../lib/api";
import { useAuth } from "../lib/auth";
import { cn } from "./ui";

function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggle = () => {
    const next = !dark;
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("theme", next ? "dark" : "light");
    } catch {
      /* private mode */
    }
    setDark(next);
  };
  return { dark, toggle };
}

function NavItem({ to, icon, children, badge, onNavigate }: { to: string; icon: ReactNode; children: ReactNode; badge?: number; onNavigate?: () => void }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive ? "bg-brand-50 text-brand-700 dark:bg-brand-700/20 dark:text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-white",
        )
      }
    >
      <span className="[&>svg]:size-4">{icon}</span>
      <span className="flex-1">{children}</span>
      {!!badge && <span className="rounded-full bg-red-500 px-1.5 py-0.5 text-[11px] leading-none font-semibold text-white">{badge}</span>}
    </NavLink>
  );
}

export function Layout() {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const theme = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: stats } = useQuery({ queryKey: ["stats", 7], queryFn: () => api.get<Stats>("/stats?days=7"), refetchInterval: 30_000 });

  const logout = async () => {
    await api.post("/auth/logout");
    qc.clear();
    qc.setQueryData(["me"], null);
  };

  const close = () => setMobileOpen(false);
  const sidebar = (
    <div className="flex h-full flex-col gap-6 px-3 py-5">
      <div className="flex items-center gap-2.5 px-3">
        <div className="grid size-8 place-items-center rounded-lg bg-brand-600 text-base text-white">💬</div>
        <div className="leading-tight">
          <div className="text-sm font-semibold">Sales Assistant</div>
          <div className="text-xs text-zinc-500">Messenger · Instagram</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        <NavItem to="/" icon={<LayoutDashboard />} onNavigate={close}>{t("nav.overview")}</NavItem>
        <NavItem to="/conversations" icon={<Inbox />} onNavigate={close}>{t("nav.inbox")}</NavItem>
        <NavItem to="/escalations" icon={<MessageCircleQuestion />} badge={stats?.openEscalations} onNavigate={close}>{t("nav.escalations")}</NavItem>
        <NavItem to="/orders" icon={<ShoppingBag />} onNavigate={close}>{t("nav.orders")}</NavItem>
        <NavItem to="/products" icon={<Package />} onNavigate={close}>{t("nav.products")}</NavItem>
        <NavItem to="/knowledge" icon={<BookOpen />} onNavigate={close}>{t("nav.knowledge")}</NavItem>
        <NavItem to="/settings" icon={<Settings />} onNavigate={close}>{t("nav.settings")}</NavItem>
      </nav>
      <div className="space-y-3 border-t border-zinc-200 px-3 pt-4 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-zinc-100 p-0.5 dark:bg-zinc-800" role="group" aria-label={t("nav.language")}>
            {LANGUAGES.map((l) => (
              <button
                key={l.code}
                type="button"
                onClick={() => void i18n.changeLanguage(l.code)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-semibold uppercase", i18n.resolvedLanguage === l.code ? "bg-white shadow-sm dark:bg-zinc-700" : "text-zinc-500")}
                title={l.label}
              >
                {l.code}
              </button>
            ))}
          </div>
          <button type="button" onClick={theme.toggle} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" title={t("nav.theme")}>
            {theme.dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs text-zinc-500">{user?.email}</span>
          <button type="button" onClick={() => void logout()} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-red-600 dark:hover:bg-zinc-800" title={t("nav.logout")}>
            <LogOut className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh lg:pl-64">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-zinc-200 bg-white lg:block dark:border-zinc-800 dark:bg-zinc-900">{sidebar}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-zinc-950/40" onClick={close} />
          <aside className="relative h-full w-64 bg-white dark:bg-zinc-900">
            <button type="button" onClick={close} className="absolute top-4 right-3 rounded p-1 text-zinc-500" aria-label="close">
              <X className="size-4" />
            </button>
            {sidebar}
          </aside>
        </div>
      )}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-zinc-200 bg-white/80 px-4 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-900/80">
        <button type="button" onClick={() => setMobileOpen(true)} className="rounded p-1.5" aria-label="menu">
          <Menu className="size-5" />
        </button>
        <span className="text-sm font-semibold">Sales Assistant</span>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
