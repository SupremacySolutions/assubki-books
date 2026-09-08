// Astro 7's CLI auto-daemonises when it detects an AI agent. The documented
// dev() API stays in this owned process, including in agent environments.
import { dev } from 'astro';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: {
  port: { type: 'string' }, host: { type: 'string' }, open: { type: 'boolean' },
} });
let stopping = false;
let server;
async function stop() {
  stopping = true;
  if (server) await server.stop();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server = await dev({ server: {
  ...(values.port ? { port: Number(values.port) } : {}),
  ...(values.host ? { host: values.host } : {}),
  ...(values.open ? { open: true } : {}),
} });
if (stopping) await server.stop();
