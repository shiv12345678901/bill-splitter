async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4173')) throw new Error('Isolated preview required.');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  await page.evaluate(async()=>{
    const {state,blank,persist}=await import('/js/store.mjs');
    state.work={...blank(),groupName:'Recovery test',members:['Alex','Jamie'],expenses:[{id:'a',merchant:'Store',date:'2026-09-09',paidBy:'Alex',amount:20}]};
    state.scan=null;state.archive=null;state.edits={};state.selected='a';state.filter='all';state.query='';persist();location.hash='receipts';
  });
  await page.locator('#receipt-form [name=merchant]').fill('Unapplied draft');
  await page.reload();
  await page.locator('.receipt-rows .receipt-summary').first().click();
  check(await page.locator('#receipt-form [name=merchant]').inputValue()==='Unapplied draft','Unsaved editor draft survives reload');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByRole('link',{name:'Payment plan',exact:true}).click();
  await page.getByRole('button',{name:'Confirm payment',exact:true}).click();
  await page.getByRole('button',{name:'Confirm received',exact:true}).click();
  await page.getByRole('button',{name:'Close settlement',exact:true}).click();
  await page.getByRole('button',{name:'Close settlement',exact:true}).last().click();
  check(await page.locator('#workspace-status').innerText()==='Completed','Settlement closes');
  await page.getByRole('link',{name:'Receipts',exact:true}).click();
  check(await page.locator('#receipt-form [name=merchant]').isDisabled(),'Completed receipts are read only');
  await page.evaluate(async()=>{
    const{state,emit}=await import('/js/store.mjs');
    state.history=[{id:'archive-fixture',groupName:'Archived house',expenses:[],startDate:'2026-08-01',endDate:'2026-08-31'}];emit();location.hash='history';
  });
  await page.getByRole('button',{name:/Archived house/}).click();
  check(await page.locator('#workspace-status').innerText()==='Saved record','History opens read only');
  await page.getByRole('button',{name:'Return to current settlement'}).click();
  check(await page.locator('#workspace-name').innerText()==='Recovery test','Archive leaves original workspace intact');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  await page.reload();
  await page.context().setOffline(true);
  try {
    await page.reload();
    await page.waitForSelector('#workspace-name');
    check(await page.locator('#workspace-name').innerText()==='Recovery test','Offline reload restores shell and local draft');
    await page.getByRole('link',{name:'Settings',exact:true}).click();
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export backup',exact:true}).click();await download;
  } finally { await page.context().setOffline(false); }
  console.log('Passed: editor draft recovery, close/read-only workflow, history isolation, offline reload and export.');
}
