import { Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./lib/auth-client";
import LoginPage from "./pages/index";
import DashboardLayout from "./layouts/DashboardLayout";
import DashboardIndexPage from "./pages/dashboard/index";
import ModelsPage from "./pages/dashboard/models";
import ApiKeysPage from "./pages/dashboard/api-keys";
import PlaygroundPage from "./pages/dashboard/playground";
import ProviderPage from "./pages/dashboard/[provider]";

function LoadingScreen() {
  return (
    <div className="opendum-loading" role="status" aria-label="Loading Opendum">
      <div className="opendum-loading__brand" aria-hidden="true">
        <span className="opendum-loading__mark">
          <span className="opendum-loading__pulse" />
          <span className="opendum-loading__dot" />
        </span>
        <span className="opendum-loading__wordmark">Opendum</span>
      </div>
    </div>
  );
}

export default function App() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return <LoadingScreen />;
  }

  const authed = Boolean(session?.user);

  return (
    <Routes>
      <Route
        path="/"
        element={
          authed ? (
            <Navigate to="/dashboard" replace />
          ) : (
            <LoginPage />
          )
        }
      />
      <Route
        path="/dashboard"
        element={
          authed ? <DashboardLayout /> : <Navigate to="/" replace />
        }
      >
        <Route index element={<DashboardIndexPage />} />
        <Route path="models" element={<ModelsPage />} />
        <Route path="api-keys" element={<ApiKeysPage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path=":provider" element={<ProviderPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
