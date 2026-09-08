// Production verification is read-only. The mutation suite belongs in local
// disposable storage; its fixture IDs and resets cannot identify live data.
for (const path of ['/', '/catalogue', '/shipments', '/basket', '/admin/login']) {
  const response = await fetch(`https://assubkibooks.co.uk${path}`, { redirect: 'manual', signal: AbortSignal.timeout(30000) });
  await response.arrayBuffer();
  if (response.status !== 200) throw new Error(`${path}: HTTP ${response.status}`);
  console.log(`PASS GET ${path}`);
}
