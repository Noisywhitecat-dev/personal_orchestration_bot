import type { TaskPlan } from '../../domain/task.js';
export function PlanCard({ plan }: { plan: TaskPlan }) {
  return (
    <section className="plan-card" aria-label="승인할 작업 계획">
      <div className="eyebrow claude-text">Claude · 기획 및 검토</div>
      <h2>{plan.title}</h2>
      <p>{plan.objective ?? plan.summary}</p>
      <ol>
        {plan.steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
      {plan.acceptanceCriteria?.length ? (
        <>
          <h3>완료 확인 기준</h3>
          <ul>
            {plan.acceptanceCriteria.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">이전 형식의 계획입니다. 위 단계와 요약을 기준으로 검토합니다.</p>
      )}
      <details>
        <summary>계획 범위와 검증 방법</summary>
        {(
          [
            ['변경 범위', plan.scope],
            ['제외 범위', plan.outOfScope],
            ['관련 파일 후보', plan.suggestedFiles],
            ['검증', plan.verification],
            ['위험 요소', plan.risks],
          ] as const
        ).map(([label, items]) => (
          <section key={label}>
            <h3>{label}</h3>
            {items?.length ? (
              <ul>
                {items.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">별도 기재 없음</p>
            )}
          </section>
        ))}
        <p>
          검증 강도:{' '}
          {plan.riskLevel === 'high'
            ? '전체 테스트와 빌드'
            : plan.riskLevel === 'low'
              ? '관련 테스트와 정적 검사'
              : '관련 테스트와 전체 타입·코드 검사'}
        </p>
      </details>
    </section>
  );
}
