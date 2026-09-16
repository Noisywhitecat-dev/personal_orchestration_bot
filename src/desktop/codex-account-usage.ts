import { spawn } from 'node:child_process';
import { BASE_ENV_KEYS } from '../infrastructure/process/process-runner.js';

/** Only the documented initialize + read handshake. Never creates a thread, turn or login. */
export function readCodexAccountUsage(
  executable: string,
  cwd: string,
  timeoutMs = 10000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of BASE_ENV_KEYS)
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn(executable, ['app-server'], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    let bytes = 0;
    let done = false;
    let initialized = false;
    const finish = (value?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.kill();
      if (value === undefined)
        reject(new Error('사용량을 조회하지 못했습니다. CLI 설치와 ChatGPT 로그인을 확인하세요.'));
      else resolve(value);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    child.on('error', () => finish());
    child.on('close', () => finish());
    child.stdin.on('error', () => finish());
    child.stderr.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144) finish();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 262144 || done) {
        finish();
        return;
      }
      buffer += chunk.toString('utf8');
      let index: number;
      while (!done && (index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id === 1 && !initialized) {
            if (msg.error || msg.result === undefined) {
              finish();
              return;
            }
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (msg.id === 2 && initialized) finish(msg.error ? undefined : msg.result);
        } catch {
          finish();
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'ai_orchestrator_usage', version: '0.1.0' } },
    });
  });
}
