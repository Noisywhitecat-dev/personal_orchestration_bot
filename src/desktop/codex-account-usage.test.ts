import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: fake.spawn }));
import { readCodexAccountUsage } from './codex-account-usage.js';
class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}
let child: Child;
beforeEach(() => {
  fake.spawn.mockReset();
  child = new Child();
  fake.spawn.mockReturnValue(child);
});
describe('read-only Codex account protocol', () => {
  it('waits for initialization then requests only limits, bounds process options and kills afterward', async () => {
    const messages: { method: string }[] = [];
    child.stdin.on('data', (chunk) => messages.push(JSON.parse(String(chunk))));
    const result = readCodexAccountUsage('codex.exe', 'C:/test');
    expect(fake.spawn).toHaveBeenCalledWith(
      'codex.exe',
      ['app-server'],
      expect.objectContaining({ shell: false, windowsHide: true, cwd: 'C:/test' }),
    );
    expect(messages.map((m) => m.method)).toEqual(['initialize']);
    child.stdout.write('{"id":1,"result":{}}\n');
    expect(messages.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'account/rateLimits/read',
    ]);
    child.stdout.write('{"id":2,"result":{"rateLimits":{}}}\n');
    expect(await result).toEqual({ rateLimits: {} });
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('rejects raw errors without exposing content and terminates timeouts/oversized output', async () => {
    const result = readCodexAccountUsage('codex', 'C:/test');
    child.stdout.write('{"id":1,"error":{"message":"SECRET"}}\n');
    await expect(result).rejects.not.toThrow('SECRET');
    child = new Child();
    fake.spawn.mockReturnValue(child);
    const large = readCodexAccountUsage('codex', 'C:/test');
    child.stderr.write('x'.repeat(262145));
    await expect(large).rejects.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
    child = new Child();
    fake.spawn.mockReturnValue(child);
    await expect(readCodexAccountUsage('codex', 'C:/test', 5)).rejects.toThrow();
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
