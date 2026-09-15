import type { UsageSummary } from '../../shared/contracts.js';

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString());

function Tags({ t }: { t: UsageSummary['claude'] }) {
  return (
    <>
      {t.hasEstimated && <span className="tag estimated">estimated</span>}
      {t.hasUnavailable && <span className="tag unavailable">unavailable</span>}
      {!t.hasEstimated && !t.hasUnavailable && t.recordCount > 0 && (
        <span className="tag">actual</span>
      )}
    </>
  );
}

export function UsageTable({ title, usage }: { title: string; usage: UsageSummary }) {
  return (
    <div>
      <h2>{title}</h2>
      <table className="usage">
        <thead>
          <tr>
            <th></th>
            <th>in</th>
            <th>cached</th>
            <th>out</th>
            <th>reason</th>
            <th>total</th>
          </tr>
        </thead>
        <tbody>
          {(['claude', 'codex'] as const).map((p) => {
            const t = usage[p];
            return (
              <tr key={p}>
                <td>
                  {p} ({t.recordCount}) <Tags t={t} />
                </td>
                <td>{fmt(t.inputTokens)}</td>
                <td>{fmt(t.cachedInputTokens)}</td>
                <td>{fmt(t.outputTokens)}</td>
                <td>{fmt(t.reasoningTokens)}</td>
                <td>{fmt(t.totalTokens)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
