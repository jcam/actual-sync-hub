import type { ProviderRuntimeDto } from "@actual-sync/shared";

export function ProviderReadinessPanel({
  provider
}: {
  provider: ProviderRuntimeDto;
}) {
  const summary = provider.ready
    ? `${provider.label} is ready for new connections and refreshes.`
    : `${provider.label} needs additional setup before it is fully ready.`;

  return (
    <section className="panel">
      <div className="connection-head">
        <div>
          <p className="eyebrow">Provider readiness</p>
          <h3>{provider.label}</h3>
          <p className="muted">
            {provider.environment ? `${provider.label} ${provider.environment}` : provider.label}
          </p>
        </div>
        <div className="status-row">
          <span className={provider.ready ? "tag success-tag" : "tag warning-tag"}>
            {provider.ready ? "READY" : "SETUP NEEDED"}
          </span>
        </div>
      </div>
      <p className={provider.ready ? "success-text" : "error-text"}>{summary}</p>
      {provider.issues.length > 0 ? (
        <div className="list-card-meta">
          {provider.issues.map(issue => (
            <span key={issue}>{issue}</span>
          ))}
        </div>
      ) : null}
      {provider.notes.length > 0 ? (
        <div className="list-card-meta">
          {provider.notes.map(note => (
            <span key={note}>{note}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
