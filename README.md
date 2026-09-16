# AI orchestrator

Claude가 **기획과 검토**를 맡고 Codex가 **코드 작성**을 맡는 개인용 로컬 데스크톱 앱입니다.
원하는 결과를 한국어로 적고 계획을 승인하면, 정해진 실행 한도 안에서 구현과 검토가 이어집니다.

## 처음 실행하기

1. `app-release/AI Orchestrator-0.1.0-x64.exe`를 실행합니다.
2. 최초 안내에 따라 **새 프로젝트** → 이름 입력 → **폴더 선택** → **프로젝트 등록**을 누릅니다.
3. 기본 **체험 모드**에서 **체험 요청 채우기** → **계획 만들기**를 누릅니다.
4. Claude의 계획, 완료 기준, 실행 요약을 읽고 **계획 승인하고 시작**을 누릅니다.
5. Codex의 구현 보고와 Claude의 검토, 완료 결과를 확인합니다.

체험에서는 실제 AI를 호출하거나 코드 파일을 바꾸지 않습니다. 표시되는 토큰은 체험용 예시입니다.
**프로젝트 AI 하네스 설치 버튼은 체험 모드에서도 실제 규칙 파일을 생성합니다.**
최초 안내를 완료하면 다시 강제로 열리지 않습니다. 왼쪽 **시작 안내**에서 다시 볼 수 있습니다.

## 실제 AI 연결

Claude Code와 Codex를 설치하고 각 CLI에 로그인한 뒤 **앱 설정**에서 실제 모드를 선택하세요.
**간편 설정**의 자동·절약·균형·품질 우선은 모델/노력치와 실행 횟수를 제안합니다.
**모델·노력치 직접 설정**에서 실행 파일, 모델별 지원 노력치, 실행 횟수, 토큰 상한, 제한 시간을 조정합니다.
**저장하고 다시 시작**은 같은 창에서 내장 서버만 재시작합니다. 프리셋이나 설정 저장은 AI를 호출하지 않습니다.

**프로젝트 준비 → 실행 전 점검**에서 폴더, Git, 실행 파일, 로그인, 모델/노력치, 하네스를 확인하세요.
점검은 `--version`, `claude auth status`, `codex login status`, 읽기 전용 Git 명령만 사용합니다.
로그인 상태 성공은 모델 접근 권한이나 잔여 요금을 보장하지 않습니다.
실제 모드에서 **계획 만들기**부터 토큰이 사용되며, 승인 이후에는 표시된 한도 안에서 후속 호출이 가능합니다.

자세한 안내는 [데스크톱 사용법](docs/DESKTOP.md)을 참고하세요.

계정별 사용률과 초기화 시각은 **메인 사이드바 → 계정 사용량**에서 확인합니다.
Codex는 읽기 전용 조회, Claude는 보고된 한도/상태 표시줄 데이터 가져오기와 공식 페이지 연결을 지원합니다.
미보고 값을 0으로 표시하지 않습니다. [동일 과제 비교 실험](docs/BENCHMARK.md)도 참고하세요.

## 프로젝트 AI 하네스

프로젝트 준비에서 설치 미리보기를 펼치면 생성 파일, 충돌, 템플릿 내용을 확인할 수 있습니다.
**확인한 파일을 프로젝트에 설치**를 눌러야 생성합니다. 기존 파일은 버전에 관계없이 덮어쓰지 않습니다.
충돌한 항목은 보존하며 생성 예시와 수동 병합 안내를 제공합니다. 하네스 없이도 기본 역할 지시로 동작합니다.

- `AGENTS.md`, `CLAUDE.md`: 없는 경우에만 짧은 역할/안전 규칙 생성
- `.claude/skills/orchestration-planner/SKILL.md`
- `.claude/skills/orchestration-reviewer/SKILL.md`
- `.agents/skills/orchestration-implementer/SKILL.md`
- `.ai-orchestrator/COLLABORATION.md`
- `.ai-orchestrator/QUALITY_GATES.md`
- `.ai-orchestrator/PROJECT_CONTEXT.md`

각 파일에는 관리 버전이 들어갑니다. 수정되거나 오래된 파일은 자동 업데이트하지 않습니다.
공식 프로젝트 탐색 경로는 [Codex 스킬 문서](https://learn.chatgpt.com/docs/build-skills)와
[Claude Code 스킬 문서](https://code.claude.com/docs/en/skills)를 확인했습니다.

## 토큰 절약과 안전 경계

- 추가 답변과 리뷰 수정은 같은 세션에 새 정보만 보냅니다. 리뷰에는 승인 계획, 현재 구현 보고,
  제한된 현재 diff, 직전 미해결 항목만 전달합니다.
- 계획에 관련 파일 후보, 허용/금지 범위, 수용 조건과 위험도별 검증을 포함합니다.
  low는 관련 테스트/정적 검사, medium은 관련 테스트/전체 typecheck·lint,
  high는 전체 테스트/build까지 권장합니다.
- 실제 CLI가 보고한 사용량, 추정, 확인 불가를 구분합니다. 모르는 값을 0으로 만들지 않습니다.
  상세 정보에서 단계별·작업별·프로젝트 누적 사용량을 볼 수 있습니다.
- 토큰 상한은 다음 실행 시작 전에 검사하는 한도입니다. 한 번의 호출이 상한을 넘을 수 있습니다.
- 앱 재시작이나 실패는 자동 AI 재호출을 하지 않습니다. 대기/실행 작업은 중단 처리하고,
  사용자 답변/승인을 기다리던 작업은 보존합니다. 새 요청은 추가 호출을 사용합니다.
- 등록 프로젝트의 정규 경로만 사용하며 하네스는 심볼릭 링크/정션을 거부하고 파일을 독점 생성합니다.
  기존 파일, 사용자 전역 설정, 외부 프로젝트를 자동 변경하지 않습니다.
- Claude는 읽기 전용, Codex는 `workspace-write`입니다. 셸 문자열이나 샌드박스 우회를 사용하지 않습니다.
- 프롬프트/diff는 메모리에서만 사용합니다. 원시 AI 메시지·명령 출력·명령 인자·작업 경로는
  실행 이벤트에 저장하지 않습니다. 구조화된 계획/보고, 사용자 대화는 작업 기록으로 저장합니다.
- 상세 정보의 **진단 요약 복사/파일 저장**은 허용된 상태·횟수·토큰 필드만 내보냅니다.
  경로, 이름, 세션 ID, 비밀값, 프롬프트, diff, 명령 출력은 제외합니다.

## 개발 및 검증

Node.js 22 이상이 필요합니다. 기본 어댑터는 Fake입니다.

```powershell
npm install
npm run dev
# 또는
npm run desktop
```

```powershell
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run desktop:dist
```

브라우저 개발 모드의 서버는 3080, Vite는 5173을 사용합니다. 데스크톱 설정은 Electron에서 제공합니다.
웹 서버 설정은 `.env.example`의 환경변수를 참고하세요. `.env`를 자동 로드하거나 API 키를 수집하지 않습니다.
`CLAUDE_ADAPTER`/`CODEX_ADAPTER`를 `cli`로 지정해야 실제 CLI가 실행됩니다.
`MAX_CLAUDE_RUNS`, `MAX_CODEX_RUNS`, `MAX_CLARIFICATION_ROUNDS`, `MAX_REVIEW_ROUNDS`,
`CLAUDE_TOKEN_CEILING`, `CODEX_TOKEN_CEILING`은 작업 기본 한도입니다.
`CLAUDE_MODEL`/`CLAUDE_EFFORT`, `CODEX_MODEL`/`CODEX_REASONING_EFFORT`, 실행 파일 및 제한 시간도
환경변수로 지정할 수 있습니다. 데스크톱에서는 저장된 앱 설정이 우선합니다.

## 문서

[제품](docs/PRODUCT.md) · [구조](docs/ARCHITECTURE.md) · [프로토콜](docs/PROTOCOL.md) ·
[사용법](docs/DESKTOP.md) · [검증 상태](docs/STATUS.md) · [현재 작업](docs/CODEX_NEXT_TASK.md)

개인용 로컬 앱입니다. 클라우드 배포, 다중 사용자 인증, 자동 커밋·푸시는 제품 범위에 포함하지 않습니다.

최근 작업 오른쪽 **삭제**에서 종료된 대화 이력을 삭제할 수 있습니다. 진행 중이면 먼저 중단하세요.
확인 후 대화·계획·실행 기록·로컬 토큰 집계를 영구 삭제하며, 프로젝트 파일과 실제 계정 사용량은 유지합니다.
사이드바에서 모델·노력치와 계정 사용량을 확인하고 **변경**에서 설정을 편집합니다.
[초보자·개발자 사용성 점검과 검증 범위](docs/UX_AUDIT.md)를 참고하세요.
