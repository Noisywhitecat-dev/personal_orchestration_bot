export type HarnessFileState = 'missing' | 'installed' | 'conflict' | 'blocked' | 'outdated';
export interface HarnessFile {
  path: string;
  state: HarnessFileState;
  /** Template only; never the contents of a user's existing file. */
  content: string;
}
export interface HarnessPreview {
  version: string;
  files: HarnessFile[];
  installed: boolean;
  guidance: string;
}
export interface HarnessInstallResult extends HarnessPreview {
  created: string[];
  skipped: string[];
}
export interface PreflightCheck {
  key: string;
  label: string;
  status: 'ok' | 'warning' | 'error';
  detail: string;
}
export interface PreflightResult {
  checks: PreflightCheck[];
  ready: boolean;
}
