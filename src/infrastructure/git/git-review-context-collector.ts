import { lstatSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { posix, resolve, sep } from 'node:path';

import type {
  OmittedFile,
  ReviewContext,
  ReviewContextCollector,
  ReviewContextInput,
} from '../../application/review-context.js';
import { unavailableReviewContext } from '../../application/review-context.js';
import { OrchestrationError } from '../../domain/errors.js';
import { assertInsideProjectRoot, runProcess } from '../process/process-runner.js';

/**
 * Collects a bounded snapshot of the working tree with read-only git commands:
 *
 *   git --no-pager -c core.quotePath=false rev-parse --show-toplevel
 *   git --no-pager -c core.quotePath=false status --porcelain=v1 -z --untracked-files=all [-- :(literal)path ...]
 *   git --no-pager -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color --relative HEAD -- :(literal)path ...
 *     (falls back to `diff --cached` + `diff` when HEAD does not exist yet)
 *
 * Every command runs through runProcess (argv array, shell:false, cwd = canonical root,
 * timeout, AbortSignal). Nothing is staged, stashed, reset or checked out. Untracked text files
 * are read directly (bounded, symlink-safe). Binary and secret-looking files contribute only
 * their path. Output is capped in bytes with UTF-8-safe truncation and an explicit marker.
 * The diff text is returned to the caller only; it is never logged.
 */

export interface GitReviewContextCollectorOptions {
  /** Total budget for `content`. Default 64 KiB. */
  maxBytes?: number;
  /** Per-file cap. Diff sections above it are cut; untracked files above it are omitted. Default 16 KiB (never above maxBytes). */
  perFileBytes?: number;
  timeoutMs?: number;
  /** Summary-only logger (counts and status, never content). */
  log?: (line: string) => void;
  /** Override the git executable name (tests). */
  gitExecutable?: string;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_PER_FILE_BYTES = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const BINARY_SNIFF_BYTES = 8_000;

/** Directories never shown, regardless of what the implementer reports. */
const EXCLUDED_DIRS = ['.git', 'node_modules', 'dist'];

/** `.env.example` is a documented template and is allowed; every other `.env*` is treated as secret. */
const ALLOWED_ENV_FILES = new Set(['.env.example']);

const SENSITIVE_BASENAME = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..*)?$/i,
  /^(credentials|secrets?)(\..*)?$/i,
  /\.secret$/i,
  /^\.(npmrc|netrc|htpasswd)$/i,
];

export function isSensitivePath(relPath: string): boolean {
  const base = posix.basename(relPath);
  if (ALLOWED_ENV_FILES.has(base)) return false;
  return SENSITIVE_BASENAME.some((re) => re.test(base));
}

export function isExcludedDir(relPath: string): boolean {
  const first = relPath.split('/')[0] ?? '';
  return EXCLUDED_DIRS.includes(first) || relPath.split('/').some((seg) => seg === '.git');
}

/**
 * Normalize implementer-reported paths to safe, root-relative POSIX paths.
 * Rejects absolute paths, control characters, traversal and pathspec magic.
 */
export function normalizeChangedFiles(
  projectRoot: string,
  files: readonly string[],
): { valid: string[]; omitted: OmittedFile[] } {
  const valid: string[] = [];
  const omitted: OmittedFile[] = [];
  const seen = new Set<string>();
  const rootWithSep = projectRoot.endsWith(sep) ? projectRoot : projectRoot + sep;

  for (const raw of files) {
    const display = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
    if (typeof raw !== 'string' || raw.length === 0 || /[\0\r\n]/.test(raw)) {
      omitted.push({ path: display, reason: 'invalid_path' });
      continue;
    }
    if (
      /^[A-Za-z]:[\\/]/.test(raw) ||
      raw.startsWith('/') ||
      raw.startsWith('\\') ||
      raw.startsWith(':')
    ) {
      omitted.push({
        path: display,
        reason: raw.startsWith(':') ? 'invalid_path' : 'outside_root',
      });
      continue;
    }
    let rel = posix.normalize(raw.replace(/\\/g, '/'));
    if (rel.startsWith('./')) rel = rel.slice(2);
    if (
      rel === '.' ||
      rel === '' ||
      rel === '..' ||
      rel.startsWith('../') ||
      rel.includes('/../')
    ) {
      omitted.push({ path: display, reason: 'outside_root' });
      continue;
    }
    rel = rel.replace(/\/+$/, '');
    const abs = resolve(projectRoot, rel);
    if (abs !== projectRoot && !abs.startsWith(rootWithSep)) {
      omitted.push({ path: display, reason: 'outside_root' });
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    valid.push(rel);
  }
  return { valid, omitted };
}

/** Cut a UTF-8 string to at most `max` bytes without splitting a multi-byte sequence. */
export function truncateUtf8(text: string, max: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return { text, truncated: false };
  let end = max;
  while (end > 0 && (buf[end] ?? 0) >= 0x80 && (buf[end] ?? 0) < 0xc0) end -= 1; // continuation byte
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

interface StatusEntry {
  path: string;
  untracked: boolean;
}

/** Parse `git status --porcelain=v1 -z` output. Rename/copy entries carry two paths; keep the new one. */
export function parsePorcelainZ(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i] ?? '';
    if (rec.length < 4) continue;
    const x = rec[0] ?? ' ';
    const y = rec[1] ?? ' ';
    const path = rec.slice(3);
    if (x === 'R' || x === 'C') i += 1; // skip the "from" path
    if (x === '!') continue; // ignored
    entries.push({ path, untracked: x === '?' && y === '?' });
  }
  return entries;
}

export class GitReviewContextCollector implements ReviewContextCollector {
  private readonly maxBytes: number;
  private readonly perFileBytes: number;
  private readonly timeoutMs: number;
  private readonly log: (line: string) => void;
  private readonly git: string;

  constructor(opts: GitReviewContextCollectorOptions = {}) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new OrchestrationError('VALIDATION_FAILED', 'maxBytes must be a positive integer.');
    }
    this.perFileBytes = Math.min(opts.perFileBytes ?? DEFAULT_PER_FILE_BYTES, this.maxBytes);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = opts.log ?? (() => undefined);
    this.git = opts.gitExecutable ?? 'git';
  }

  async collect(input: ReviewContextInput): Promise<ReviewContext> {
    let root: string;
    try {
      root = assertInsideProjectRoot(input.projectRoot, input.projectRoot).projectRoot;
    } catch {
      return this.finish(unavailableReviewContext('Project root is not accessible.'));
    }
    const signal = input.signal;
    const { valid: scope, omitted } = normalizeChangedFiles(root, input.changedFiles);

    // 1. Is this a git repository whose top level is the project root (or an ancestor)?
    const top = await this.run(root, ['rev-parse', '--show-toplevel'], signal);
    if (signal?.aborted) return this.finish(unavailableReviewContext('Cancelled.'));
    if (top.exitCode !== 0) {
      return this.finish({
        ...unavailableReviewContext('Not a git repository; no diff collected.'),
        omitted,
      });
    }

    // 2. What changed (tracked + untracked), limited to the reported scope when we have one.
    const pathspec = scope.map((p) => `:(literal)${p}`);
    const status = await this.run(
      root,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
        ...(pathspec.length ? ['--', ...pathspec] : []),
      ],
      signal,
    );
    if (signal?.aborted) return this.finish(unavailableReviewContext('Cancelled.'));
    if (status.exitCode !== 0) {
      return this.finish({
        ...unavailableReviewContext('git status failed; no diff collected.'),
        omitted,
      });
    }

    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const e of parsePorcelainZ(status.stdout)) {
      const rel = e.path.replace(/\\/g, '/');
      if (isExcludedDir(rel)) {
        omitted.push({ path: rel, reason: 'excluded_dir' });
        continue;
      }
      if (isSensitivePath(rel)) {
        omitted.push({ path: rel, reason: 'sensitive' });
        continue;
      }
      (e.untracked ? untracked : tracked).push(rel);
    }

    // 3. Tracked changes as a unified diff against HEAD (staged + unstaged in one view).
    const sections: string[] = [];
    const files: string[] = [];
    let truncated = false;
    let warning: string | null = null;

    if (tracked.length) {
      const trackedSpec = tracked.map((p) => `:(literal)${p}`);
      const diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative'];
      let diff = await this.run(root, [...diffArgs, 'HEAD', '--', ...trackedSpec], signal);
      if (signal?.aborted) return this.finish(unavailableReviewContext('Cancelled.'));
      if (diff.exitCode !== 0) {
        // No HEAD yet (unborn branch): staged vs empty tree, then unstaged vs index.
        const staged = await this.run(
          root,
          [...diffArgs, '--cached', '--', ...trackedSpec],
          signal,
        );
        const work = await this.run(root, [...diffArgs, '--', ...trackedSpec], signal);
        if (signal?.aborted) return this.finish(unavailableReviewContext('Cancelled.'));
        if (staged.exitCode !== 0 || work.exitCode !== 0) {
          return this.finish({
            ...unavailableReviewContext('git diff failed; no diff collected.'),
            omitted,
          });
        }
        diff = {
          exitCode: 0,
          stdout: staged.stdout + work.stdout,
          overflow: staged.overflow || work.overflow,
        };
      }
      if (diff.overflow) truncated = true;
      for (const section of splitDiffSections(diff.stdout)) {
        const cut = truncateUtf8(section.text, this.perFileBytes);
        if (cut.truncated) truncated = true;
        sections.push(
          cut.truncated
            ? `${cut.text}\n[... diff for this file cut at ${this.perFileBytes} bytes ...]`
            : cut.text,
        );
        files.push(section.path ?? '(unknown)');
      }
    }

    // 4. Untracked files: bounded, symlink-safe, text only.
    for (const rel of untracked) {
      const read = this.readUntracked(root, rel);
      if ('reason' in read) {
        omitted.push({ path: rel, reason: read.reason });
        continue;
      }
      sections.push(`=== Untracked file added: ${rel} (${read.bytes} bytes) ===\n${read.text}`);
      files.push(rel);
    }

    if (sections.length === 0) {
      return this.finish({
        status: 'empty',
        content: '',
        files: [],
        omitted,
        truncated: false,
        bytes: 0,
        warning,
      });
    }

    // 5. Total budget.
    let content = sections.join('\n');
    const cut = truncateUtf8(content, this.maxBytes);
    if (cut.truncated) {
      truncated = true;
      content = `${cut.text}\n[... review context truncated at ${this.maxBytes} bytes; remaining changes not shown ...]`;
    } else if (truncated) {
      content = `${content}\n[... some sections were cut; see per-file markers ...]`;
    }
    if (truncated) warning = 'Diff truncated to the configured byte limit.';

    return this.finish({
      status: 'available',
      content,
      files,
      omitted,
      truncated,
      bytes: Buffer.byteLength(content, 'utf8'),
      warning,
    });
  }

  private finish(ctx: ReviewContext): ReviewContext {
    // Counts only; never the diff.
    this.log(
      `[review-context] status=${ctx.status} files=${ctx.files.length} bytes=${ctx.bytes} truncated=${ctx.truncated} omitted=${ctx.omitted.length}`,
    );
    return ctx;
  }

  private async run(
    root: string,
    args: string[],
    signal: AbortSignal | undefined,
  ): Promise<{ exitCode: number | null; stdout: string; overflow: boolean }> {
    // Hard cap on what we buffer from git: a few times the budget is plenty for truncation.
    const cap = Math.max(this.maxBytes * 4, 256 * 1024);
    try {
      const proc = runProcess({
        file: this.git,
        args: ['--no-pager', '-c', 'core.quotePath=false', ...args],
        cwd: root,
        projectRoot: root,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: cap,
        ...(signal ? { signal } : {}),
        // Intentionally no `log`: the runner's summary line is fine, but we keep git quiet here
        // to avoid any chance of paths leaking through a shared logger.
      });
      const chunks: string[] = [];
      let bytes = 0;
      let overflow = false;
      for await (const line of proc.stdoutLines()) {
        if (bytes > cap) {
          overflow = true;
          continue; // keep draining so the process can exit
        }
        chunks.push(line + '\n');
        bytes += Buffer.byteLength(line, 'utf8') + 1;
      }
      const result = await proc.done;
      if (result.outcome !== 'exited') return { exitCode: null, stdout: '', overflow: false };
      // `-z` output has no newlines; joining with "\n" would corrupt it, so strip the one we added.
      const stdout = args.includes('-z') ? chunks.join('').replace(/\n$/, '') : chunks.join('');
      return { exitCode: result.exitCode, stdout, overflow: overflow || result.stdoutTruncated };
    } catch {
      return { exitCode: null, stdout: '', overflow: false };
    }
  }

  private readUntracked(
    root: string,
    rel: string,
  ): { text: string; bytes: number } | { reason: OmittedFile['reason'] } {
    const abs = resolve(root, rel);
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    try {
      const l = lstatSync(abs);
      if (l.isSymbolicLink()) return { reason: 'symlink' };
      const real = realpathSync.native(abs);
      if (real !== root && !real.startsWith(rootWithSep)) return { reason: 'outside_root' };
      const st = statSync(real);
      if (!st.isFile()) return { reason: 'invalid_path' };
      if (st.size > this.perFileBytes) return { reason: 'too_large' };
      const fd = openSync(real, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, this.perFileBytes));
        const n = readSync(fd, buf, 0, buf.length, 0);
        const head = buf.subarray(0, Math.min(n, BINARY_SNIFF_BYTES));
        if (head.includes(0)) return { reason: 'binary' };
        return { text: buf.subarray(0, n).toString('utf8'), bytes: n };
      } finally {
        closeSync(fd);
      }
    } catch {
      return { reason: 'invalid_path' };
    }
  }
}

/** Split unified diff output into per-file sections, extracting the "b/" path from each header. */
export function splitDiffSections(diff: string): Array<{ path: string | null; text: string }> {
  if (!diff.trim()) return [];
  const out: Array<{ path: string | null; text: string }> = [];
  const parts = diff.split(/^(?=diff --git )/m);
  for (const part of parts) {
    if (!part.trim()) continue;
    const m = /^diff --git a\/(.*?) b\/(.*)$/m.exec(part);
    out.push({ path: m?.[2] ?? null, text: part.replace(/\n$/, '') });
  }
  return out;
}
