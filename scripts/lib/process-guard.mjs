// A separate process is necessary: SIGKILL cannot run a JS signal handler.
const group = Number(process.argv[2]);
process.on('disconnect', () => {
  try { process.kill(-group, 'SIGTERM'); } catch { process.exit(0); }
  setTimeout(() => {
    try { process.kill(-group, 'SIGKILL'); } catch {}
    process.exit(0);
  }, 3000);
});
