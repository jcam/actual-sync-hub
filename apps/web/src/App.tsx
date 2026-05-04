import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import type { SessionDto } from "@actual-sync/shared";
import { api } from "./api";
import { AccountsPage } from "./routes/AccountsPage";
import { CategoryMappingsPage } from "./routes/CategoryMappingsPage";
import { ConnectionsPage } from "./routes/ConnectionsPage";
import { LoginPage } from "./routes/LoginPage";
import { ReviewPage } from "./routes/ReviewPage";

function Layout({
  session,
  onLogout
}: {
  session: SessionDto;
  onLogout: () => Promise<void>;
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Actual Sync Hub</p>
          <h1>Provider-driven syncing for Actual Budget</h1>
          <p className="muted">
            Link Actual accounts to external sources, choose a sync cadence, and keep provider adapters isolated from the Actual integration layer.
          </p>
        </div>
        <nav className="nav">
          <NavLink to="/accounts" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Accounts
          </NavLink>
          <NavLink to="/connections" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Plaid Connections
          </NavLink>
        </nav>
        <div className="session-card">
          <div>
            <p className="muted">Signed in as</p>
            <strong>{session.username}</strong>
          </div>
          <button className="ghost-button" onClick={() => void onLogout()}>
            Log out
          </button>
        </div>
      </aside>
      <main className="main-panel">
        <Routes>
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:actualAccountId/mappings" element={<CategoryMappingsPage />} />
          <Route path="/accounts/:actualAccountId/migration" element={<ReviewPage />} />
          <Route path="/accounts/:actualAccountId/sync-review" element={<ReviewPage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="*" element={<Navigate to="/accounts" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    void api
      .getSession()
      .then(setSession)
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="loading-screen">Loading…</div>;
  }

  if (!session?.authenticated) {
    return (
      <LoginPage
        onLogin={async (username, password) => {
          const nextSession = await api.login(username, password);
          setSession(nextSession);
          navigate("/accounts");
        }}
      />
    );
  }

  return (
    <Layout
      session={session}
      onLogout={async () => {
        await api.logout();
        setSession({ authenticated: false });
      }}
    />
  );
}
