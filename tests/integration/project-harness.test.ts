import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installHarness,
  installedRoleInstruction,
  previewHarness,
} from '../../src/infrastructure/harness/project-harness.js';
import { HARNESS_TEMPLATES } from '../../src/infrastructure/harness/templates.js';
import { preflight } from '../../src/infrastructure/preflight.js';
import type { RuntimeStatusResponse } from '../../src/shared/contracts.js';

const roots: string[] = [];
function temp() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orch-harness-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('project harness', () => {
  it('previews without writes and installs only contained templates, then is idempotent', () => {
    const root = temp();
    const preview = previewHarness(root);
    expect(preview.files).toHaveLength(8);
    expect(existsSync(join(root, '.ai-orchestrator'))).toBe(false);
    for (const file of preview.files)
      expect(resolve(root, file.path).startsWith(root + sep)).toBe(true);
    const result = installHarness(root);
    expect(result.created).toHaveLength(8);
    expect(result.installed).toBe(true);
    expect(installHarness(root).created).toEqual([]);
    for (const file of result.files)
      expect(readFileSync(join(root, file.path), 'utf8')).toBe(file.content);
    expect(installedRoleInstruction(root, 'implement')).toContain('.agents/skills/');
    expect(installedRoleInstruction(root, 'review')).toContain('.claude/skills/');
  });
  it('preserves instructions and existing skills, reports partial installation and manual merge', () => {
    const root = temp();
    writeFileSync(join(root, 'AGENTS.md'), 'USER-RULE');
    const skill = '.claude/skills/orchestration-planner';
    mkdirSync(join(root, skill), { recursive: true });
    writeFileSync(join(root, skill, 'SKILL.md'), 'MY-SKILL');
    const result = installHarness(root);
    expect(result.created).toHaveLength(6);
    expect(result.skipped).toContain('AGENTS.md');
    expect(result.files.find((f) => f.path === 'AGENTS.md')?.state).toBe('conflict');
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe('USER-RULE');
    expect(readFileSync(join(root, skill, 'SKILL.md'), 'utf8')).toBe('MY-SKILL');
    expect(installedRoleInstruction(root, 'plan')).toBeNull();
    expect(result.guidance).toContain('병합');
  });
  it('blocks junction ancestors and leaves the outside sentinel unchanged', () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, 'sentinel'), 'unchanged');
    symlinkSync(outside, join(root, '.claude'), 'junction');
    const result = installHarness(root);
    expect(
      result.files.filter((f) => f.path.startsWith('.claude/')).every((f) => f.state === 'blocked'),
    ).toBe(true);
    expect(existsSync(join(outside, 'skills'))).toBe(false);
    expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
    expect(result.created).toHaveLength(6);
  });
  it('blocks a replaced root, intermediate regular file, and newly introduced conflict', () => {
    const root = temp();
    const outside = temp();
    const child = join(root, 'child');
    symlinkSync(outside, child, 'junction');
    expect(installHarness(child).created).toEqual([]);
    writeFileSync(join(root, '.agents'), 'not a directory');
    previewHarness(root);
    writeFileSync(join(root, 'CLAUDE.md'), 'created after preview');
    const result = installHarness(root);
    expect(result.files.find((f) => f.path.startsWith('.agents/'))?.state).toBe('blocked');
    expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('created after preview');
  });
  it('reports modified versioned templates without overwriting', () => {
    const root = temp();
    installHarness(root);
    const path = '.ai-orchestrator/PROJECT_CONTEXT.md';
    const modified = HARNESS_TEMPLATES[path] + 'USER CONTEXT';
    writeFileSync(join(root, path), modified);
    const result = installHarness(root);
    expect(result.files.find((f) => f.path === path)?.state).toBe('outdated');
    expect(readFileSync(join(root, path), 'utf8')).toBe(modified);
  });
});

describe('token-free preflight', () => {
  const runtime = {
    claude: { adapter: 'cli', model: 'sonnet', effort: 'medium' },
    codex: { adapter: 'cli', model: 'gpt-5.5', effort: 'xhigh' },
  } as RuntimeStatusResponse;
  it('uses only fixed readonly argv and exposes no command output or private executable', async () => {
    const calls: string[][] = [];
    const result = await preflight(
      temp(),
      runtime,
      { claude: 'PRIVATE-CLAUDE', codex: 'PRIVATE-CODEX' },
      async (_file, args) => {
        calls.push(args);
        return true;
      },
    );
    expect(calls).toEqual([
      ['rev-parse', '--is-inside-work-tree'],
      ['--version'],
      ['auth', 'status'],
      ['--version'],
      ['login', 'status'],
    ]);
    expect(result.ready).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('never probes AI executables in fake mode; missing paths stop all probes', async () => {
    const fake = {
      ...runtime,
      claude: { ...runtime.claude, adapter: 'fake' as const },
      codex: { ...runtime.codex, adapter: 'fake' as const },
    };
    const calls: string[] = [];
    await preflight(temp(), fake, { claude: 'claude', codex: 'codex' }, async (file) => {
      calls.push(file);
      return false;
    });
    expect(calls).toEqual(['git']);
    const result = await preflight(
      join(temp(), 'missing'),
      runtime,
      { claude: 'claude', codex: 'codex' },
      async () => {
        throw new Error('must not call');
      },
    );
    expect(result.ready).toBe(false);
  });
  it('reports unsupported efforts and authentication uncertainty', async () => {
    const result = await preflight(
      temp(),
      { ...runtime, claude: { ...runtime.claude, effort: 'xhigh' } },
      { claude: 'claude', codex: 'codex' },
      async (_file, args) => args[0] === '--version',
    );
    expect(result.checks.find((c) => c.key === 'claude-model')?.status).toBe('error');
    expect(result.checks.find((c) => c.key === 'codex-auth')?.status).toBe('warning');
    expect(result.ready).toBe(false);
  });
});
