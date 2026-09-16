import type { AgentError } from './agent-events.js';

const MESSAGES: Readonly<Record<string, string>> = {
  CANCELLED: '실행이 중단되었습니다. 변경 내역을 확인한 뒤 새 작업으로 요청하세요.',
  TIMEOUT: '제한 시간 안에 실행을 마치지 못했습니다. 설정의 제한 시간과 작업 범위를 확인하세요.',
  SPAWN_FAILED: 'AI 실행 파일을 시작하지 못했습니다. 실행 전 점검에서 경로와 로그인을 확인하세요.',
  CLAUDE_ERROR:
    'Claude 실행에 실패했습니다. 로그인과 계정 사용 한도를 확인한 뒤 새 작업으로 요청하세요.',
  CODEX_ERROR: 'Codex 실행에 실패했습니다. 실행 전 점검과 계정 상태를 확인하세요.',
  CODEX_ITEM_ERROR: 'Codex 내부 작업이 실패했습니다. 프로젝트 환경과 실행 파일을 확인하세요.',
  CODEX_EXITED_WITHOUT_RESULT:
    'Codex가 결과를 반환하지 않고 종료되었습니다. 환경을 확인한 뒤 새 작업으로 요청하세요.',
  CLAUDE_EXITED_WITHOUT_RESULT:
    'Claude가 결과를 반환하지 않고 종료되었습니다. 환경을 확인한 뒤 새 작업으로 요청하세요.',
  AGENT_RESULT_INVALID:
    'AI 결과 형식을 확인할 수 없습니다. 작업 기록을 확인한 뒤 새 작업으로 요청하세요.',
  IMPLEMENTATION_FAILED: '코드 작성을 마치지 못했습니다. 작업 범위를 확인하고 다시 요청하세요.',
  UNSUPPORTED_KIND: '현재 AI 역할로 처리할 수 없는 작업입니다. 앱 설정을 확인하세요.',
  AGENT_RUN_FAILED: 'AI 실행을 마치지 못했습니다. 실행 전 점검 후 새 작업으로 요청하세요.',
};

/** Provider error text can contain prompt echoes, credentials or command output. Never retain it. */
export function safeAgentFailure(error: AgentError): AgentError {
  const code = Object.hasOwn(MESSAGES, error.code) ? error.code : 'AGENT_RUN_FAILED';
  return { code, message: MESSAGES[code]! };
}
