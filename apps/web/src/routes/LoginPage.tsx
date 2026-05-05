import { useState } from "react";
import { getDisplayErrorMessage } from "../lib/errors";

export function LoginPage({
  onLogin
}: {
  onLogin: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  return (
    <div className="login-shell">
      <div className="login-card">
        <p className="eyebrow">Protected frontend</p>
        <h1>Actual Sync Hub</h1>
        <p className="muted">
          Sign in with the locally configured admin account. This is designed for a self-hosted sync container, not a multi-tenant SaaS setup.
        </p>
        <form
          className="login-form"
          onSubmit={async event => {
            event.preventDefault();
            setError("");

            try {
              await onLogin(username, password);
            } catch (nextError) {
              setError(
                getDisplayErrorMessage(nextError, "Login failed.", {
                  serverUnavailableMessage: "Could not reach the API server to sign in."
                })
              );
            }
          }}
        >
          <label>
            <span>Username</span>
            <input value={username} onChange={event => setUsername(event.target.value)} />
          </label>
          <label>
            <span>Password</span>
            <input type="password" value={password} onChange={event => setPassword(event.target.value)} />
          </label>
          {error ? <p className="error-text">{error}</p> : null}
          <button className="primary-button" type="submit">
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
