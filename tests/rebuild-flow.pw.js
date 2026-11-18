async (page) => {
  if (!page.url().startsWith('http://127.0.0.1:4173')) throw new Error('Use isolated preview only.');
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const check=(condition,message)=>{if(!condition)throw new Error(message);};
  await page.evaluate(()=>{localStorage.removeItem('splitmate-desktop-v2');localStorage.removeItem('splitmate-workspace-v1');});
  await page.reload();
  await page.getByRole('button',{name:'Edit details',exact:true}).click();
  await page.getByLabel('Household name').fill('Harbour house');
  await page.getByLabel('People sharing these expenses').fill('Alex\nJamie\nMorgan');
  await page.getByRole('button',{name:'Save details',exact:true}).click();
  await page.getByRole('button',{name:'Add an expense',exact:true}).click();
  await page.getByLabel('Merchant or description').fill('Woolworths');
  await page.getByLabel('Amount · AUD').fill('60.01');
  await page.getByRole('button',{name:'Add expense',exact:true}).click();
  await page.waitForURL('**/#receipts');
  check(await page.locator('#receipt-form [name=amount]').inputValue()==='60.01','Expense detail should open');
  await page.getByLabel('Amount · AUD').fill('0');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  check(await page.evaluate(async()=>{const{state}=await import('/js/store.mjs');return state.work.expenses[0].amount;})===60.01,'Invalid edit must not save');
  await page.getByLabel('Amount · AUD').fill('90');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await page.getByRole('link',{name:'Payment plan',exact:true}).click();
  check(await page.getByRole('button',{name:'Confirm payment',exact:true}).count()===2,'Two transfers expected');
  await page.getByRole('button',{name:'Confirm payment',exact:true}).first().click();
  await page.getByRole('button',{name:'Confirm received',exact:true}).click();
  await page.getByRole('button',{name:'Confirm payment',exact:true}).first().click();
  await page.getByRole('button',{name:'Confirm received',exact:true}).click();
  check(await page.getByRole('button',{name:'Close settlement',exact:true}).isEnabled(),'Fully paid settlement can close');
  await page.getByRole('link',{name:'Receipts',exact:true}).click();
  await page.getByLabel('Amount · AUD').fill('93');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  check(await page.evaluate(async()=>{const{state}=await import('/js/store.mjs');return Object.keys(state.work.payments).length;})===0,'Editing must invalidate payment confirmations');
  await page.getByRole('button',{name:'Exclude from split',exact:true}).click();
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await page.reload();
  check(await page.evaluate(async()=>{const{state}=await import('/js/store.mjs');return state.work.expenses[0].amount;})===93,'Draft must survive reload');
  await page.evaluate(async()=>{
    const {state,persist}=await import('/js/store.mjs');
    state.work.expenses.push(...Array.from({length:23},(_,i)=>({id:'fixture-'+i,merchant:'Receipt '+i,date:'2026-09-09',paidBy:'Jamie',amount:10,category:'Groceries',confidence:i===0?'LOW':'HIGH'})));
    persist();
  });
  await page.getByLabel('Filter receipts').selectOption('review');
  check(await page.locator('.receipt-rows .receipt-summary').count()===1,'Review filter isolates issues');
  await page.getByLabel('Filter receipts').selectOption('all');
  await page.getByLabel('Search receipts').fill('Woolworths');
  check(await page.locator('.receipt-rows .receipt-summary').count()===1,'Search filters');
  await page.getByLabel('Search receipts').fill('');
  await page.getByRole('button',{name:'Next page',exact:true}).click();
  check(await page.locator('.pagination').innerText().then(t=>t.includes('2 of 3')),'Pagination works');
  await page.evaluate(async()=>{
    const{state,persist}=await import('/js/store.mjs');
    state.scan={id:'recovery',active:true,context:{groupId:state.work.groupId,groupName:state.work.groupName,startDate:state.work.startDate,endDate:state.work.endDate},incoming:[{id:'recovered',merchant:'Recovered',date:'2026-09-09',paidBy:'Alex',amount:4}]};persist();
  });
  await page.reload();
  check(await page.getByRole('button',{name:'Keep recovered receipts'}).isVisible(),'Interrupted scan offers recovery');
  await page.getByRole('button',{name:'Keep recovered receipts'}).click();
  check(await page.evaluate(async()=>{const{state}=await import('/js/store.mjs');return state.work.expenses.some(e=>e.id==='recovered');}),'Recovered receipt is retained');
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
    await page.setViewportSize({width,height:1000});await page.evaluate(t=>window.setAppearance(t),theme);
    for(const route of ['home','receipts','settlements','history','settings']){
      await page.evaluate(r=>location.hash=r,route);await page.waitForTimeout(60);
      check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow ${theme} ${width} ${route}`);
    }
  }
  await page.setViewportSize({width:1440,height:1050});await page.evaluate(()=>{window.setAppearance('light');location.hash='home';});
  await page.screenshot({path:'output/playwright/rebuild-overview.png',fullPage:true});
  await page.getByRole('link',{name:'Receipts',exact:true}).click();
  await page.locator('.receipt-rows .receipt-summary').first().click();
  await page.screenshot({path:'output/playwright/rebuild-receipts.png',fullPage:true});
  await page.evaluate(()=>window.setAppearance('dark'));await page.getByRole('link',{name:'Payment plan',exact:true}).click();
  await page.screenshot({path:'output/playwright/rebuild-payments-dark.png',fullPage:true});
  check(errors.length===0,errors.join('\n'));
  console.log('Passed: expense CRUD, validation, payment confirmation/reset, draft reload, scan recovery, filters, pagination, and 40 desktop/theme layouts.');
}
