async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4173')) throw new Error('Isolated preview required.');
  await page.goto('http://127.0.0.1:4173/#home');
  await page.evaluate(async () => {
    const { state, blank, persist } = await import('/js/store.mjs');
    const { socket } = await import('/js/connection.mjs');
    window.scanJobEmissions = [];
    socket.emit = (event, payload) => window.scanJobEmissions.push({ event, payload });
    state.work = { ...blank(), groupId: 'scan-group', groupName: 'Scan household', members: ['Alex', 'Jamie'] };
    state.scan = {
      id: 'durable-job',
      status: 'queued',
      active: false,
      context: { groupId: 'scan-group', groupName: 'Scan household', startDate: '2026-09-01', endDate: '2026-09-30' },
      incoming: [],
      estimate: { imageCount: 18, cachedImages: 7, maximumApiCalls: 11 },
      expectedImages: 18,
      completedImages: 0,
    };
    state.lastScanReport = null;
    state.error = '';
    state.online = true;
    state.status = 'READY';
    state.keys = 1;
    persist();
  });
  await page.getByText('18 images found · 7 already saved · up to 11 recognition requests').waitFor();
  await page.getByRole('button', { name: 'Start scan', exact: true }).click();
  const started = await page.evaluate(() => window.scanJobEmissions.some((item) => item.event === 'scan:run' && item.payload.jobId === 'durable-job'));
  if (!started) throw new Error('Queued scan did not start the durable job.');
  await page.evaluate(async () => {
    const { socket } = await import('/js/connection.mjs');
    socket.listeners('scan:job').forEach((fn) => fn({
      runId: 'durable-job',
      job: { jobId: 'durable-job', status: 'running', expectedImages: 18, completedImages: 9, message: 'Audited 9 of 18 images…' },
      outcomes: [],
    }));
  });
  await page.getByText('Audited 9 of 18 images…').waitFor();
  await page.evaluate(async () => {
    const { socket } = await import('/js/connection.mjs');
    socket.listeners('scan:complete').forEach((fn) => fn({
      runId: 'durable-job',
      job: { jobId: 'durable-job', status: 'partial' },
      reconciliation: { expected: 18, completed: 18, processed: 14, excluded: 2, failed: 1, skipped: 1, apiCalls: 11, skippedReasons: { quota: 1, 'Unsupported media type: application/pdf': 1 } },
      expenses: [],
    }));
  });
  await page.getByText('14 processed · 2 excluded · 1 failed · 1 skipped').waitFor();
  await page.getByText('Unsupported media type: application/pdf').waitFor();
  await page.setViewportSize({ width: 1440, height: 950 });
  await page.screenshot({ path: 'output/playwright/scan-reconciliation.png', fullPage: true });
  await page.setViewportSize({ width: 320, height: 800 });
  if (await page.locator('.scan-status').evaluate((card) => card.scrollWidth > card.clientWidth))
    throw new Error('Scan reconciliation content overflows its card at 320px.');
  await page.screenshot({ path: 'output/playwright/scan-reconciliation-narrow.png', fullPage: true });
  await page.getByRole('button', { name: 'Retry failed images', exact: true }).click();
  const retried = await page.evaluate(() => window.scanJobEmissions.some((item) => item.event === 'scan:retry_failed' && item.payload.jobId === 'durable-job'));
  if (!retried) throw new Error('Failed-only retry did not target the existing job.');
  console.log('Passed: scan estimate, durable progress, reconciliation reasons, failed-only retry, and narrow-card layout.');
}
