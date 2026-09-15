import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GitReviewContextCollector,
  isSensitivePath,
  normalizeChangedFiles,
  parsePorcelainZ,
  splitDiffSections,
  truncateUtf8,
} from '../../src/infrastructure/git/git-review-context-collector.js';

// Real temp git repositories; git config is set only inside them. No network, no stash/reset.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tempDir(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

/** Repo with one committed file `src/a.ts` (3 lines). */
function repo(): string {
  const root = tempDir('rc-repo-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.ts'), 'line1\nline2\nline3\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

function collector(extra: ConstructorParameters<typeof GitReviewContextCollector>[0] = {}) {
  return new GitReviewContextCollector({ timeoutMs: 10_000, ...extra });
}

describe('GitReviewContextCollector: git states', () => {
  it('tracked unstaged change', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'line1\nCHANGED\nline3\n');
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.status).toBe('available');
    expect(ctx.files).toEqual(['src/a.ts']);
    expect(ctx.content).toContain('-line2');
    expect(ctx.content).toContain('+CHANGED');
    expect(ctx.truncated).toBe(false);
    expect(ctx.bytes).toBe(Buffer.byteLength(ctx.content));
  });

  it('staged change, and staged + unstaged in one view against HEAD', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'line1\nSTAGED\nline3\n');
    git(root, 'add', 'src/a.ts');
    const staged = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(staged.content).toContain('+STAGED');

    writeFileSync(join(root, 'src', 'a.ts'), 'line1\nSTAGED\nline3\nUNSTAGED\n');
    const both = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(both.content).toContain('+STAGED');
    expect(both.content).toContain('+UNSTAGED');
    expect(both.files).toEqual(['src/a.ts']);
  });

  it('untracked text file content is included and labelled', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'new.ts'), 'export const fresh = 1;\n');
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.status).toBe('available');
    expect(ctx.files).toEqual(['src/new.ts']);
    expect(ctx.content).toContain('=== Untracked file added: src/new.ts');
    expect(ctx.content).toContain('export const fresh = 1;');
  });

  it('binary untracked file is omitted, tracked binary shows no bytes', async () => {
    const root = repo();
    writeFileSync(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    writeFileSync(join(root, 'blob.bin'), Buffer.from([1, 2, 0, 4]));
    git(root, 'add', 'blob.bin');
    git(root, 'commit', '-q', '-m', 'bin');
    writeFileSync(join(root, 'blob.bin'), Buffer.from([9, 9, 0, 9, 9]));
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.omitted).toContainEqual({ path: 'img.png', reason: 'binary' });
    expect(ctx.content).not.toContain('PNG');
    expect(ctx.content).toContain('Binary files');
    expect(ctx.content).not.toContain('\u0000');
  });

  it('sensitive files contribute only their path; .env.example is allowed', async () => {
    const root = repo();
    writeFileSync(join(root, '.env'), 'SECRET=hunter2\n');
    writeFileSync(join(root, '.env.local'), 'TOKEN=abc\n');
    writeFileSync(join(root, 'server.pem'), 'PRIVATE KEY MATERIAL\n');
    mkdirSync(join(root, 'keys'));
    writeFileSync(join(root, 'keys', 'id_rsa'), 'ssh-rsa PRIVATE\n');
    writeFileSync(join(root, '.env.example'), 'PORT=3080\n');
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.content).not.toContain('hunter2');
    expect(ctx.content).not.toContain('TOKEN=abc');
    expect(ctx.content).not.toContain('PRIVATE');
    expect(ctx.content).toContain('PORT=3080');
    const omittedPaths = ctx.omitted
      .filter((o) => o.reason === 'sensitive')
      .map((o) => o.path)
      .sort();
    expect(omittedPaths).toEqual(['.env', '.env.local', 'keys/id_rsa', 'server.pem']);
    expect(ctx.files).toEqual(['.env.example']);
  });

  it('excluded directories never appear even when reported', async () => {
    const root = repo();
    mkdirSync(join(root, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'x', 'index.js'), 'module.exports = 1;');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'out.js'), 'built');
    writeFileSync(join(root, 'src', 'a.ts'), 'changed\n');
    const ctx = await collector().collect({
      projectRoot: root,
      changedFiles: ['node_modules/x/index.js', 'dist/out.js', 'src/a.ts'],
    });
    expect(ctx.files).toEqual(['src/a.ts']);
    expect(ctx.content).not.toContain('module.exports');
    expect(ctx.content).not.toContain('built');
    expect(ctx.omitted.map((o) => o.reason)).toEqual(['excluded_dir', 'excluded_dir']);
  });

  it('changedFiles restricts the scope; other changes are not shown', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'A-CHANGED\n');
    writeFileSync(join(root, 'other.txt'), 'OTHER-NEW\n');
    const ctx = await collector().collect({ projectRoot: root, changedFiles: ['src/a.ts'] });
    expect(ctx.files).toEqual(['src/a.ts']);
    expect(ctx.content).toContain('A-CHANGED');
    expect(ctx.content).not.toContain('OTHER-NEW');
  });

  it('absolute, traversal, control-char and pathspec-magic hints are rejected', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'changed\n');
    const ctx = await collector().collect({
      projectRoot: root,
      changedFiles: [
        '/etc/passwd',
        'C:\\Windows\\system32\\drivers\\etc\\hosts',
        '../outside.txt',
        'src/../../escape.txt',
        'bad\nname.ts',
        ':(top)src/a.ts',
        'src/a.ts',
        'src\\a.ts',
        './src/a.ts',
      ],
    });
    const reasons = ctx.omitted.map((o) => `${o.path}:${o.reason}`);
    expect(reasons).toContain('/etc/passwd:outside_root');
    expect(reasons).toContain('C:\\Windows\\system32\\drivers\\etc\\hosts:outside_root');
    expect(reasons).toContain('../outside.txt:outside_root');
    expect(reasons).toContain('src/../../escape.txt:outside_root');
    expect(reasons).toContain('bad\nname.ts:invalid_path');
    expect(reasons).toContain(':(top)src/a.ts:invalid_path');
    expect(ctx.files).toEqual(['src/a.ts']); // deduplicated across the three spellings
  });

  it('paths with spaces, Korean, unicode and a leading dash are handled literally', async () => {
    const root = repo();
    const names = ['with space.ts', '한글 파일.ts', 'émoji-😀.ts', '-starts-with-dash.ts'];
    for (const n of names) writeFileSync(join(root, n), `content of ${n}\n`);
    const ctx = await collector().collect({ projectRoot: root, changedFiles: names });
    expect(ctx.status).toBe('available');
    for (const n of names) {
      expect(ctx.files).toContain(n);
      expect(ctx.content).toContain(`content of ${n}`);
    }
    // Glob characters in a reported path are literal, not patterns.
    writeFileSync(join(root, 'star.ts'), 'STAR\n');
    const glob = await collector().collect({ projectRoot: root, changedFiles: ['*.ts'] });
    expect(glob.content).not.toContain('STAR');
  });

  it('symlink pointing outside the root is not read', async () => {
    const root = repo();
    const outside = tempDir('rc-outside-');
    writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n');
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file');
    } catch {
      return; // symlink creation not permitted on this machine; nothing to verify
    }
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.content).not.toContain('OUTSIDE-SECRET');
    expect(ctx.omitted.some((o) => o.path === 'link.txt' && o.reason === 'symlink')).toBe(true);
  });

  it('non-git directory → unavailable with a warning', async () => {
    const root = tempDir('rc-plain-');
    writeFileSync(join(root, 'x.txt'), 'x');
    const ctx = await collector().collect({ projectRoot: root, changedFiles: ['x.txt'] });
    expect(ctx.status).toBe('unavailable');
    expect(ctx.warning).toContain('Not a git repository');
    expect(ctx.content).toBe('');
  });

  it('git executable failure → unavailable', async () => {
    const root = repo();
    const ctx = await collector({ gitExecutable: join(root, 'no-such-git') }).collect({
      projectRoot: root,
      changedFiles: [],
    });
    expect(ctx.status).toBe('unavailable');
  });

  it('clean tree → empty', async () => {
    const root = repo();
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.status).toBe('empty');
    expect(ctx.content).toBe('');
    expect(ctx.files).toEqual([]);
  });

  it('repository without HEAD (no commits) still works via cached/worktree fallback', async () => {
    const root = tempDir('rc-unborn-');
    git(root, 'init', '-q');
    writeFileSync(join(root, 'first.ts'), 'first\n');
    git(root, 'add', 'first.ts');
    writeFileSync(join(root, 'second.ts'), 'second\n');
    const ctx = await collector().collect({ projectRoot: root, changedFiles: [] });
    expect(ctx.status).toBe('available');
    expect(ctx.content).toContain('+first');
    expect(ctx.content).toContain('Untracked file added: second.ts');
  });

  it('total byte limit truncates safely with a marker', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), '한'.repeat(4000) + '\n'); // 3 bytes each
    const ctx = await collector({ maxBytes: 1001, perFileBytes: 100_000 }).collect({
      projectRoot: root,
      changedFiles: [],
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.content).toContain('[... review context truncated at 1001 bytes');
    expect(ctx.content).not.toContain('\uFFFD'); // no broken UTF-8
    expect(ctx.warning).toContain('truncated');
    const body = ctx.content.slice(0, ctx.content.indexOf('\n[... review context'));
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(1001);
  });

  it('per-file limit cuts a huge diff section and omits a huge untracked file', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'x'.repeat(5000) + '\n');
    writeFileSync(join(root, 'big.txt'), 'y'.repeat(5000));
    writeFileSync(join(root, 'small.txt'), 'small\n');
    const ctx = await collector({ maxBytes: 64 * 1024, perFileBytes: 1000 }).collect({
      projectRoot: root,
      changedFiles: [],
    });
    expect(ctx.content).toContain('[... diff for this file cut at 1000 bytes ...]');
    expect(ctx.omitted).toContainEqual({ path: 'big.txt', reason: 'too_large' });
    expect(ctx.content).toContain('Untracked file added: small.txt');
    expect(ctx.truncated).toBe(true);
  });

  it('AbortSignal cancels collection', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'changed\n');
    const controller = new AbortController();
    controller.abort();
    const ctx = await collector().collect({
      projectRoot: root,
      changedFiles: [],
      signal: controller.signal,
    });
    expect(ctx.status).toBe('unavailable');
    expect(ctx.warning).toBe('Cancelled.');
  });

  it('logger receives counts only, never diff content or paths', async () => {
    const root = repo();
    writeFileSync(join(root, 'src', 'a.ts'), 'SECRET-DIFF-LINE\n');
    const logs: string[] = [];
    const ctx = await collector({ log: (l) => logs.push(l) }).collect({
      projectRoot: root,
      changedFiles: [],
    });
    expect(ctx.content).toContain('SECRET-DIFF-LINE');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(
      /^\[review-context\] status=available files=1 bytes=\d+ truncated=false omitted=0$/,
    );
    expect(logs.join('\n')).not.toContain('SECRET-DIFF-LINE');
    expect(logs.join('\n')).not.toContain('a.ts');
  });

  it('rejects an invalid byte budget at construction', () => {
    expect(() => new GitReviewContextCollector({ maxBytes: 0 })).toThrow();
    expect(() => new GitReviewContextCollector({ maxBytes: -5 })).toThrow();
    expect(() => new GitReviewContextCollector({ maxBytes: Number.NaN })).toThrow();
  });
});

describe('helpers', () => {
  it('truncateUtf8 never splits a multi-byte character', () => {
    const s = 'a한b'; // a=1, 한=3, b=1
    expect(truncateUtf8(s, 5)).toEqual({ text: 'a한b', truncated: false });
    expect(truncateUtf8(s, 4)).toEqual({ text: 'a한', truncated: true });
    expect(truncateUtf8(s, 3)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8(s, 2)).toEqual({ text: 'a', truncated: true });
    expect(truncateUtf8('😀😀', 5)).toEqual({ text: '😀', truncated: true });
  });

  it('parsePorcelainZ handles renames and untracked entries', () => {
    const out = ['R  new.ts', 'old.ts', ' M mod.ts', '?? fresh.ts', 'A  added.ts'].join('\0');
    expect(parsePorcelainZ(out)).toEqual([
      { path: 'new.ts', untracked: false },
      { path: 'mod.ts', untracked: false },
      { path: 'fresh.ts', untracked: true },
      { path: 'added.ts', untracked: false },
    ]);
  });

  it('splitDiffSections extracts per-file sections', () => {
    const diff =
      'diff --git a/x.ts b/x.ts\nindex 1..2\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/y.ts b/y.ts\n--- a/y.ts\n+++ b/y.ts\n@@ -1 +1 @@\n-c\n+d\n';
    const sections = splitDiffSections(diff);
    expect(sections.map((s) => s.path)).toEqual(['x.ts', 'y.ts']);
    expect(sections[1]?.text).toContain('+d');
    expect(splitDiffSections('')).toEqual([]);
  });

  it('isSensitivePath and normalizeChangedFiles basics', () => {
    expect(isSensitivePath('.env')).toBe(true);
    expect(isSensitivePath('config/.env.production')).toBe(true);
    expect(isSensitivePath('.env.example')).toBe(false);
    expect(isSensitivePath('src/credentials.json')).toBe(true);
    expect(isSensitivePath('src/app.ts')).toBe(false);
    const root = tempDir('rc-norm-');
    const { valid, omitted } = normalizeChangedFiles(root, ['a.ts', 'a.ts', 'dir\\b.ts', '', '..']);
    expect(valid).toEqual(['a.ts', 'dir/b.ts']);
    expect(omitted.map((o) => o.reason)).toEqual(['invalid_path', 'outside_root']);
  });
});
