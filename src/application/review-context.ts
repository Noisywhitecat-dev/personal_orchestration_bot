/**
 * Port for collecting a bounded, read-only snapshot of the project's working-tree changes
 * so the reviewer can see what actually changed. The result lives in memory only: it is
 * embedded into one review prompt and never persisted, logged, or sent over SSE.
 */

export interface ReviewContextInput {
  /** Canonical absolute project root. Nothing outside it is read. */
  projectRoot: string;
  /** Paths reported by the implementer. A scope hint, never proof of authorship; validated by the collector. */
  changedFiles: readonly string[];
  signal?: AbortSignal;
}

export type ReviewContextStatus =
  /** Diff text is present (possibly truncated). */
  | 'available'
  /** The working tree has no reviewable changes. */
  | 'empty'
  /** Could not collect (not a git repo, git failed, collector disabled). See `warning`. */
  | 'unavailable';

export type OmitReason =
  | 'invalid_path'
  | 'outside_root'
  | 'excluded_dir'
  | 'sensitive'
  | 'binary'
  | 'too_large'
  | 'symlink';

export interface OmittedFile {
  path: string;
  reason: OmitReason;
}

export interface ReviewContext {
  status: ReviewContextStatus;
  /** Bounded UTF-8 text. Empty unless `status === 'available'`. */
  content: string;
  /** Files whose changes are represented in `content`. */
  files: string[];
  /** Files deliberately left out, with the reason (paths only, never contents). */
  omitted: OmittedFile[];
  truncated: boolean;
  bytes: number;
  /** Human-readable note for `unavailable` or partial results; safe to show in a prompt. */
  warning: string | null;
}

export interface ReviewContextCollector {
  collect(input: ReviewContextInput): Promise<ReviewContext>;
}

export function unavailableReviewContext(warning: string): ReviewContext {
  return {
    status: 'unavailable',
    content: '',
    files: [],
    omitted: [],
    truncated: false,
    bytes: 0,
    warning,
  };
}

/** Default when no collector is configured: the reviewer is told the diff is unavailable. */
export const noReviewContextCollector: ReviewContextCollector = {
  collect: async () => unavailableReviewContext('No review context collector is configured.'),
};
