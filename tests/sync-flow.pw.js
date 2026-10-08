async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4173')) throw new Error('Isolated preview required.');
  await page.goto('http://127.0.0.1:4173/#home');
  await page.reload();
  await page.evaluate(async () => {
    const { state, blank, persist } = await import('/js/store.mjs');
    const { socket } = await import('/js/connection.mjs');
    const { today } = await import('/js/domain.mjs');
    window.syncEmissions = [];
    socket.emit = (event, payload) => { window.syncEmissions.push({event, payload}); };
    window.fakeCurrentCycle = (startDate) => ({ id: 'cycle_current', status: 'ACTIVE', groupId: 'test-group', startDate, endDate: today(), groceryCount: 1, paymentCount: 0, groceryMessages: [], paymentMessages: [] });
    state.work = {...blank(),groupId:'test-group',startDate:'2026-08-25',endDate:'2026-09-01',members:['Alex','Jamie'],expenses:[{id:'existing',date:'2026-08-26',merchant:'Edited merchant',paidBy:'Alex',amount:25,reviewed:true,isExcluded:true}],payments:{confirmed:'2026-09-01'}};
    state.archive=null;state.scan=null;state.online=true;state.status='READY';state.keys=1;state.edits={};persist();
    window.testToday=today();
  });
  await page.getByRole('button',{name:'↻ Sync receipts',exact:true}).click();
  await page.evaluate(async()=>{
    const {state}=await import('/js/store.mjs');const {socket}=await import('/js/connection.mjs');
    if (!window.syncEmissions.some(e=>e.event==='detect:cycles')) throw new Error('Sync did not look for the current cycle first');
    socket.listeners('cycles:detected').forEach(fn=>fn({cycles:[window.fakeCurrentCycle('2026-08-25')]}));
    const request=window.syncEmissions.find(e=>e.event==='scan:prepare').payload;
    if(request.startDate!=='2026-08-25'||request.endDate!==window.testToday||request.sync!==true||request.cycleId!=='cycle_current')throw new Error('Sync did not scan the current cycle');
    const workId=state.work.id;
    socket.listeners('scan:complete').forEach(fn=>fn({runId:state.scan.id,expenses:[{id:'existing',date:'2026-08-26',merchant:'Original OCR',paidBy:'Alex',amount:100},{id:'new',date:window.testToday,merchant:'New receipt',paidBy:'Jamie',amount:10}]}));
    if(state.work.id!==workId||state.work.expenses.length!==2||state.work.expenses[0].amount!==25||!state.work.expenses[0].isExcluded)throw new Error('Sync replaced existing edits');
    if(state.work.endDate!==window.testToday||!state.work.lastSyncedAt||Object.keys(state.work.payments).length)throw new Error('Sync state incorrect');
    state.work.payments={confirmed:'kept'};
  });
  await page.getByRole('button',{name:'↻ Sync receipts',exact:true}).click();
  await page.evaluate(async()=>{
    const{state}=await import('/js/store.mjs');const{socket}=await import('/js/connection.mjs');
    // The marker moved the cycle start earlier: sync widens the period instead of resetting it.
    socket.listeners('cycles:detected').forEach(fn=>fn({cycles:[window.fakeCurrentCycle('2026-08-01')]}));
    const request=window.syncEmissions.filter(e=>e.event==='scan:prepare').at(-1).payload;
    if(request.startDate!=='2026-08-01')throw new Error('Sync did not follow the marker backwards');
    socket.listeners('scan:complete').forEach(fn=>fn({runId:state.scan.id,expenses:structuredClone(state.work.expenses)}));
    if(state.work.startDate!=='2026-08-01'||state.work.expenses.length!==2||state.work.payments.confirmed!=='kept')throw new Error('Repeated sync duplicated receipts, dropped the widened period, or reset unchanged payments');
  });
  console.log('Sync verified: scans the current cycle from the last marker, follows the marker backwards, preserves edits and exclusions, no duplicates, appropriate payment reset.');
}
