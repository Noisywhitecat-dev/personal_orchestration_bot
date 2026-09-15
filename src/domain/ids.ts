// Branded ID types. Runtime representation is a plain string; the brand only
// prevents accidentally passing a TaskId where a RunId is expected.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type ProjectId = Brand<string, 'ProjectId'>;
export type TaskId = Brand<string, 'TaskId'>;
export type RunId = Brand<string, 'RunId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type UsageRecordId = Brand<string, 'UsageRecordId'>;
export type TaskEventId = Brand<string, 'TaskEventId'>;

export const asProjectId = (s: string): ProjectId => s as ProjectId;
export const asTaskId = (s: string): TaskId => s as TaskId;
export const asRunId = (s: string): RunId => s as RunId;
export const asSessionId = (s: string): SessionId => s as SessionId;
export const asMessageId = (s: string): MessageId => s as MessageId;
export const asUsageRecordId = (s: string): UsageRecordId => s as UsageRecordId;
export const asTaskEventId = (s: string): TaskEventId => s as TaskEventId;

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;
