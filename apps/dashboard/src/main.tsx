import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Toaster, toast } from "sonner";
import "./i18n";
import i18n from "./i18n";
import "./index.css";
import { Layout } from "./components/Layout";
import { Loading } from "./components/ui";
import { AuthProvider, useAuth } from "./lib/auth";
import { LoginPage } from "./pages/Login";

const Overview = lazy(() => import("./pages/Overview"));
const Conversations = lazy(() => import("./pages/Conversations"));
const Escalations = lazy(() => import("./pages/Escalations"));
const Orders = lazy(() => import("./pages/Orders"));
const Products = lazy(() => import("./pages/Products"));
const Knowledge = lazy(() => import("./pages/Knowledge"));
const SettingsPage = lazy(() => import("./pages/Settings"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } },
  // Every failed mutation surfaces as a toast; pages only handle success.
  mutationCache: new MutationCache({ onError: (err) => toast.error(err.message || i18n.t("common.error")) }),
});

function Guarded() {
  const { user, loading } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <LoginPage />;
  return <Layout />;
}

function App() {
  return (
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route element={<Guarded />}>
          <Route index element={<Overview />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<Conversations />} />
          <Route path="escalations" element={<Escalations />} />
          <Route path="escalations/:id" element={<Escalations />} />
          <Route path="orders" element={<Orders />} />
          <Route path="products" element={<Products />} />
          <Route path="knowledge" element={<Knowledge />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="settings/:tab" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <App />
          <Toaster richColors position="top-right" />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
