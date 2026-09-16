# M17 — 초보자용 데스크톱 협업 흐름

기준: PR #15의 bd593ab가 HEAD에 포함됨을 확인했다. 단일 Codex 에이전트가 구현한다.

## 실행 계약

- 채팅 중심 한국어 UI, 역할별 컴포넌트/view-model, 최초 안내, 간편/고급 설정.
- 등록 프로젝트별 하네스 미리보기와 명시적 설치. 기존 파일/심볼릭 링크 보존 및 충돌 보고.
- 선택 필드를 사용하는 호환 가능한 계획/구현 계약, 역할별 프롬프트, 짧은 세션 resume.
- 토큰 없는 실행 전 점검, 안전한 실행 요약, 복구 안내, 허용 목록 기반 진단 내보내기, Fake 체험.
- 위험도별 검증 권장, 실제 usage와 추정/확인 불가 구분 유지.

## 범위

허용: src/**, tests/**, README.md, docs/{PRODUCT,ARCHITECTURE,PROTOCOL,DESKTOP,STATUS,CODEX_NEXT_TASK}.md.
검증용 임시 파일은 data/m17-validation/ 및 OS 테스트 임시 디렉터리에만 생성하고 납품 전 정리한다.
금지: 상태 머신 전이/실행 한도 완화, SQLite 보안 후퇴, 외부 프로젝트/운영 데이터/전역 설정 변경,
실제 AI 호출, 불필요한 새 의존성.
사용자 후속 승인: 필요한 경우 한국어 커밋/푸시 및 작은 단위 PR 생성 가능.
기존 AGENTS.md, CLAUDE.md 및 사용자 스킬은 자동 덮어쓰지 않는다.

## 완료 기준

기존 데이터 호환, parser/resume, 하네스 경로/충돌/부분 설치, 진단 민감 정보 제거,
Fake 전체 흐름, 모델 노력치 필터, 설정 재시작, 주요 UI 상태를 테스트한다.
변경 완료 후 npm test, npm run typecheck, npm run lint, npm run format:check,
npm run build, git diff --check, 가능하면 npm run desktop:dist를 실행한다.
격리된 Fake 앱으로 최초 안내부터 완료까지, 하네스/설정/작은 창/콘솔을 확인하고
README 및 제품/구조/프로토콜/데스크톱/상태 문서를 갱신한다.

상태: 구현 진행 중. 실제 AI 호출 허용 횟수: 0.
