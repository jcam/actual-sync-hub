import { useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import type { SessionDto } from "@actual-sync/shared";
import { api } from "./api";
import { getDisplayErrorMessage } from "./lib/errors";
import { AccountsPage } from "./routes/AccountsPage";
import { CategoryMappingsPage } from "./routes/CategoryMappingsPage";
import { LoginPage } from "./routes/LoginPage";
import { PlaidConnectionsPage } from "./routes/PlaidConnectionsPage";
import { ReviewPage } from "./routes/ReviewPage";
import { SimpleFinConnectionsPage } from "./routes/SimpleFinConnectionsPage";
import { TellerConnectionsPage } from "./routes/TellerConnectionsPage";

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
          <NavLink to="/plaid-connections" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Plaid Connections
          </NavLink>
          <NavLink to="/teller-connections" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            Teller.io Connections
          </NavLink>
          <NavLink to="/simplefin-connections" className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}>
            SimpleFIN Connections
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
          <Route path="/plaid-connections" element={<PlaidConnectionsPage />} />
          <Route path="/teller-connections" element={<TellerConnectionsPage />} />
          <Route path="/simplefin-connections" element={<SimpleFinConnectionsPage />} />
          <Route path="*" element={<Navigate to="/accounts" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const navigate = useNavigate();

  const loadSession = async () => {
    try {
      const nextSession = await api.getSession();
      setSession(nextSession);
      setLoadError(null);
    } catch (sessionError) {
      setSession(null);
      setLoadError(
        getDisplayErrorMessage(sessionError, "Failed to load the current session.", {
          serverUnavailableMessage: "Could not reach the API server while loading the current session."
        })
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadSession();
  }, []);

  if (loading) {
    return <div className="loading-screen">Loading…</div>;
  }

  if (loadError) {
    return (
      <section className="panel">
        <p className="eyebrow">Session</p>
        <h2>Could not start the app</h2>
        <p className="error-text">{loadError}</p>
        <div className="button-row">
          <button
            className="ghost-button"
            onClick={() => {
              setLoading(true);
              void loadSession();
            }}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!session?.authenticated) {
    return (
      <LoginPage
        onLogin={async (username, password) => {
          const nextSession = await api.login(username, password);
          setSession(nextSession);
          void navigate("/accounts");
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
