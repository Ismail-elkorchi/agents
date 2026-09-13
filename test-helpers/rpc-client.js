import { spawn } from 'node:child_process';

export function rpcClient(args) {
  const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0;
  let stderr = '';
  const pending = new Map();
  const notifications = [];
  const waiters = new Set();
  child.stderr.setEncoding('utf8').on('data', (value) => {
    stderr += value;
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      for (const item of pending.values())
        item.reject(new Error(`RPC exited (${code ?? signal}): ${stderr}`));
      for (const waiter of waiters)
        waiter.reject(new Error(`RPC exited before ${waiter.method}: ${stderr}`));
      resolve({ code, signal, stderr });
    });
  });
  let buffered = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      receive(line);
    }
  });
  function receive(line) {
    const value = JSON.parse(line);
    if ('id' in value) {
      const request = pending.get(value.id);
      if (request === undefined) throw new Error(`Unexpected RPC response: ${line}`);
      pending.delete(value.id);
      if (value.error)
        request.reject(Object.assign(new Error(value.error.message), { code: value.error.code }));
      else request.resolve(value.result);
    } else {
      notifications.push(value);
      for (const waiter of waiters)
        if (waiter.method === value.method && waiter.predicate(value.params)) {
          waiters.delete(waiter);
          waiter.resolve(value.params);
        }
    }
  }
  return {
    child,
    exited,
    notifications,
    request(method, params = {}) {
      const id = ++sequence;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return result;
    },
    notification(method, predicate = () => true) {
      const existing = notifications.find((value) => value.method === method && predicate(value.params));
      if (existing !== undefined) return Promise.resolve(existing.params);
      return new Promise((resolve, reject) => waiters.add({ method, predicate, resolve, reject }));
    },
    async close() {
      child.stdin.end();
      return exited;
    }
  };
}
