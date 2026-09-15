import type { IsoTimestamp, ProjectId } from './ids.js';

export interface Project {
  id: ProjectId;
  name: string;
  /** Canonical absolute path to the project root. Adapters must never leave it. */
  rootPath: string;
  createdAt: IsoTimestamp;
}
