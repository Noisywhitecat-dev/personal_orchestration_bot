import { useState } from 'react';
const steps = [
  [
    '프로젝트 선택',
    '왼쪽의 새 프로젝트에서 작업할 폴더를 등록하세요. 체험은 빈 폴더로 시작해도 됩니다.',
  ],
  [
    'Claude와 Codex 확인',
    '프로젝트 준비에서 실행 전 점검을 누르세요. 실제 모드는 실행 파일과 로그인 상태를 토큰 없이 확인합니다.',
  ],
  [
    '체험 또는 실제 모드',
    '처음에는 앱 설정에서 체험 모드를 선택하세요. 실제 모드는 요청을 보낼 때부터 AI 토큰을 사용합니다.',
  ],
  [
    '모델과 노력치',
    '앱 설정의 간편 설정에서 자동·절약·균형·품질 우선을 선택하세요. 직접 조정은 고급 설정에서 할 수 있습니다.',
  ],
  [
    '프로젝트 하네스',
    '설치 미리보기에서 생성될 파일과 충돌을 확인하세요. 설치 버튼을 눌러야 파일이 생성됩니다. 기존 파일은 보존합니다.',
  ],
  [
    '테스트 실행',
    '체험 요청 채우기를 누르고 계획 만들기 → 계획 승인 순서로 전체 흐름을 확인하세요. 체험은 실제 코드나 토큰을 사용하지 않습니다.',
  ],
] as const;
export function Onboarding({
  onClose,
  onSettings,
}: {
  onClose: () => Promise<void>;
  onSettings: () => void;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = steps[step]!;
  return (
    <section className="onboarding" aria-label="처음 시작 안내">
      <div className="eyebrow">
        처음 시작하기 · {step + 1}/{steps.length}
      </div>
      <h2>{current[0]}</h2>
      <p>{current[1]}</p>
      <div className="guide-dots" aria-label="안내 단계">
        {steps.map(([title], i) => (
          <button
            key={title}
            aria-label={`${i + 1}단계 ${title}`}
            aria-current={step === i ? 'step' : undefined}
            onClick={() => setStep(i)}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="button-row">
        {step > 0 && (
          <button className="secondary" onClick={() => setStep(step - 1)}>
            이전
          </button>
        )}
        {step < steps.length - 1 ? (
          <button onClick={() => setStep(step + 1)}>다음</button>
        ) : (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void onClose().catch(() => {
                setError('안내 설정을 저장하지 못했습니다. 다시 시도하세요.');
                setBusy(false);
              });
            }}
          >
            안내 완료
          </button>
        )}
        <button className="text-button" onClick={onSettings}>
          앱 설정 열기
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
