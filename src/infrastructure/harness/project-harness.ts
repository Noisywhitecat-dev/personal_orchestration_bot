import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { RunKind } from '../../domain/run.js';
import type {
  HarnessFileState,
  HarnessInstallResult,
  HarnessPreview,
} from '../../shared/project-tools.js';
import { HARNESS_TEMPLATES, HARNESS_VERSION } from './templates.js';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Reject every existing symlink/junction, including a replaced registered root. No user path input. */
function safePath(root: string, path: string, createParents = false): string {
  if (realpathSync.native(root) !== root || !lstatSync(root).isDirectory()) throw new Error('root');
  const target = resolve(root, path);
  if (!inside(root, target)) throw new Error('outside');
  const parts = relative(root, target).split(sep);
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = resolve(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (createParents && i < parts.length - 1) {
        mkdirSync(current);
        stat = lstatSync(current);
      }
    }
    if (
      stat &&
      (stat.isSymbolicLink() ||
        !inside(root, realpathSync.native(current)) ||
        (i < parts.length - 1 && !stat.isDirectory()))
    )
      throw new Error('unsafe');
  }
  return target;
}

function state(root: string, path: string, template: string): HarnessFileState {
  try {
    const target = safePath(root, path);
    let stat;
    try {
      stat = lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
    if (!stat.isFile() || stat.size > 64 * 1024) return 'conflict';
    const text = readFileSync(target, 'utf8');
    if (text === template) return 'installed';
    return /<!-- ai-orchestrator harness v[\d.]+ -->/.test(text) ? 'outdated' : 'conflict';
  } catch {
    return 'blocked';
  }
}

export function previewHarness(root: string): HarnessPreview {
  const files = Object.entries(HARNESS_TEMPLATES).map(([path, content]) => ({
    path,
    content,
    state: state(root, path, content),
  }));
  return {
    version: HARNESS_VERSION,
    files,
    installed: files
      .filter((f) => f.path.includes('/skills/'))
      .every((f) => f.state === 'installed'),
    guidance:
      '기존 파일은 보존합니다. 충돌하거나 수정된 파일은 아래 생성 예시를 비교해 필요한 규칙만 직접 병합하세요. 경로가 차단되면 연결 폴더 대신 프로젝트 안의 일반 폴더를 사용하세요. 하네스 없이도 작업할 수 있습니다.',
  };
}

/** Synchronous check/create with exclusive creation: cannot truncate existing files. Partial success is explicit. */
export function installHarness(root: string): HarnessInstallResult {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [path, content] of Object.entries(HARNESS_TEMPLATES)) {
    if (state(root, path, content) !== 'missing') {
      skipped.push(path);
      continue;
    }
    try {
      const target = safePath(root, path, true);
      safePath(root, relative(root, dirname(target)));
      writeFileSync(target, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      created.push(path);
    } catch {
      skipped.push(path);
    }
  }
  return { ...previewHarness(root), created, skipped };
}

export function installedRoleInstruction(root: string, kind: RunKind): string | null {
  const role = kind === 'plan' ? 'planner' : kind === 'review' ? 'reviewer' : 'implementer';
  const path = `${role === 'implementer' ? '.agents' : '.claude'}/skills/orchestration-${role}/SKILL.md`;
  const template = HARNESS_TEMPLATES[path];
  return template && state(root, path, template) === 'installed'
    ? `Use the project skill orchestration-${role} at ${path}.`
    : null;
}
