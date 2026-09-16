import { lstatSync, realpathSync } from 'node:fs';
import type { RuntimeStatusResponse } from '../shared/contracts.js';
import { DEFAULT_MODEL_CATALOG, type ModelCatalog } from '../shared/model-catalog.js';
import type { PreflightCheck, PreflightResult } from '../shared/project-tools.js';
import { previewHarness } from './harness/project-harness.js';
import { runProcess } from './process/process-runner.js';

export type Probe = (file: string, args: string[], root: string) => Promise<boolean>;
const probe: Probe = async (file, args, root) => {
  try {
    const child = runProcess({
      file,
      args,
      cwd: root,
      projectRoot: root,
      timeoutMs: 8000,
      maxOutputBytes: 1024,
    });
    for await (const _line of child.stdoutLines()) {
      void _line; /* Discard authentication details. */
    }
    const result = await child.done;
    return result.outcome === 'exited' && result.exitCode === 0;
  } catch {
    return false;
  }
};

/** Fixed token-free argv only. No generation, login mutation, output, credentials or version persisted. */
export async function preflight(
  root: string,
  runtime: RuntimeStatusResponse,
  executables: { claude: string; codex: string },
  run: Probe = probe,
  catalog: ModelCatalog = DEFAULT_MODEL_CATALOG,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  let valid = false;
  try {
    valid = lstatSync(root).isDirectory() && realpathSync.native(root) === root;
  } catch {
    /* missing */
  }
  checks.push({
    key: 'root',
    label: '프로젝트 폴더',
    status: valid ? 'ok' : 'error',
    detail: valid
      ? '등록된 폴더에 접근할 수 있습니다.'
      : '폴더가 이동되었거나 연결 경로입니다. 프로젝트를 다시 등록하세요.',
  });
  if (!valid) return { checks, ready: false };
  const git = await run('git', ['rev-parse', '--is-inside-work-tree'], root);
  checks.push({
    key: 'git',
    label: 'Git 저장소',
    status: git ? 'ok' : 'warning',
    detail: git
      ? '변경 내용을 검토할 수 있습니다.'
      : 'Git 저장소를 확인하지 못해 변경 검토가 제한됩니다. 실제 Codex 작업 전에 Git 저장소를 준비하세요.',
  });
  for (const provider of ['claude', 'codex'] as const) {
    const config = runtime[provider];
    const fake = config.adapter === 'fake';
    const executable = fake || (await run(executables[provider], ['--version'], root));
    checks.push({
      key: `${provider}-executable`,
      label: `${provider === 'claude' ? 'Claude' : 'Codex'} 실행 파일`,
      status: executable ? 'ok' : 'error',
      detail: fake
        ? '체험 모드에서는 실행 파일이 필요하지 않습니다.'
        : executable
          ? '실행 파일을 확인했습니다.'
          : '실행 파일을 찾거나 실행하지 못했습니다. 앱 설정에서 경로를 확인하세요.',
    });
    const authenticated =
      !fake &&
      executable &&
      (await run(
        executables[provider],
        provider === 'claude' ? ['auth', 'status'] : ['login', 'status'],
        root,
      ));
    checks.push({
      key: `${provider}-auth`,
      label: `${provider === 'claude' ? 'Claude' : 'Codex'} 로그인`,
      status: fake || authenticated ? 'ok' : 'warning',
      detail: fake
        ? '체험 모드는 로그인이나 토큰을 사용하지 않습니다.'
        : authenticated
          ? '로그인 상태 명령이 성공했습니다. 모델 접근 권한은 실제 실행 시 확인됩니다.'
          : '로그인 상태를 확인하지 못했습니다. 터미널에서 해당 CLI에 로그인하고 다시 점검하세요.',
    });
    const model = catalog[provider].find((m) => m.id === config.model);
    const compatible = !config.effort || Boolean(model?.efforts.some((e) => e === config.effort));
    checks.push({
      key: `${provider}-model`,
      label: `${provider === 'claude' ? 'Claude' : 'Codex'} 모델과 노력치`,
      status: compatible ? 'ok' : 'error',
      detail: compatible
        ? '기본값 또는 호환되는 조합입니다.'
        : '호환되지 않거나 확인되지 않은 조합입니다. 고급 설정에서 모델과 지원 노력치를 다시 선택하세요.',
    });
  }
  const harness = previewHarness(root);
  checks.push({
    key: 'harness',
    label: '프로젝트 AI 하네스',
    status: harness.installed ? 'ok' : 'warning',
    detail: harness.installed
      ? '역할별 스킬이 설치되어 있습니다.'
      : '미설치 또는 일부 충돌입니다. 설치 미리보기를 확인하세요. 기본 역할 지시로 계속 사용할 수 있습니다.',
  });
  return { checks, ready: checks.every((c) => c.status !== 'error') };
}
