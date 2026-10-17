// Transport only. Runs inside the network namespace; the application remains
// the supported CLI, with its own normal tools, context, persistence and recovery.
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';

const server = createServer((incoming, outgoing) => {
  const upstream = request({ socketPath: '/provider.sock', path: incoming.url,
    method: incoming.method, headers: { 'content-type': 'application/json' } }, response => {
    outgoing.writeHead(response.statusCode, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', () => outgoing.destroy());
  incoming.pipe(upstream);
  outgoing.on('close', () => upstream.destroy());
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const cli = '/build/node_modules/@ismail-elkorchi/coding-agent/dist/cli.js';
const common = ['--root', '/work', '--state-root', '/state', '--config', 'evaluation.config.json',
  '--provider-endpoint', `http://127.0.0.1:${server.address().port}`, ...process.argv.slice(2)];
const trust = spawn(process.execPath, [cli, 'trust', 'trusted', '--root', '/work', '--state-root', '/state'], { stdio: ['ignore', 'ignore', 'inherit'] });
const code = await new Promise(resolve => trust.once('exit', resolve));
if (code !== 0) process.exit(code ?? 1);
const application = spawn(process.execPath, [cli, 'rpc', ...common], { stdio: 'inherit' });
application.once('exit', (exitCode, signal) => {
  server.closeAllConnections();
  server.close();
  process.exitCode = signal ? 1 : (exitCode ?? 1);
});
