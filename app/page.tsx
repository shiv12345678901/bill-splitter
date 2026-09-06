'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, Camera, Check, ChevronRight, Copy, Home, MoreHorizontal, PieChart, ReceiptText, Settings, Users, X } from 'lucide-react';

type Member = { name: string; initials: string; color: string };
type Expense = { id: number | string; merchant: string; amount: number; category: string; payer: string; date: string; image?: string };
type Draft = { merchant: string; amount: string; category: string; image: string; file: File | null };

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void>;
    };
  }
}

const members: Member[] = [
  { name: 'Alex', initials: 'AL', color: '#d8ff7e' },
  { name: 'Sam', initials: 'SA', color: '#ffb88b' },
  { name: 'Jordan', initials: 'JO', color: '#8fdcff' },
  { name: 'Taylor', initials: 'TA', color: '#d6b8ff' },
];

const starterExpenses: Expense[] = [
  { id: 1, merchant: 'Woolworths', amount: 126.4, category: 'Groceries', payer: 'Alex', date: 'Today, 9:42 am' },
  { id: 2, merchant: 'AGL Energy', amount: 94.8, category: 'Utilities', payer: 'Sam', date: 'Yesterday, 6:18 pm' },
  { id: 3, merchant: 'Bunnings', amount: 68.2, category: 'Household', payer: 'Jordan', date: '3 Sep, 2:30 pm' },
  { id: 4, merchant: 'Thai Pothong', amount: 58.6, category: 'Dining', payer: 'Taylor', date: '1 Sep, 8:12 pm' },
];

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });

function Avatar({ member, small = false }: { member: Member; small?: boolean }) {
  return <span className={`grid shrink-0 place-items-center rounded-full font-bold text-[#172033] ${small ? 'h-9 w-9 text-[11px]' : 'h-12 w-12 text-xs'}`} style={{ background: member.color }} aria-hidden="true">{member.initials}</span>;
}

export default function HomePage() {
  const [activeMember, setActiveMember] = useState('Alex');
  const [expenses, setExpenses] = useState(starterExpenses);
  const [tab, setTab] = useState<'home' | 'settle'>('home');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toast, setToast] = useState('');
  const [draft, setDraft] = useState<Draft>({ merchant: '', amount: '', category: 'Groceries', image: '', file: null });
  const fileRef = useRef<HTMLInputElement>(null);
  const total = useMemo(() => expenses.reduce((sum, expense) => sum + expense.amount, 0), [expenses]);
  const share = total / members.length;
  const balances = useMemo(() => members.map((member) => ({ ...member, paid: expenses.filter((expense) => expense.payer === member.name).reduce((sum, expense) => sum + expense.amount, 0) })), [expenses]);

  useEffect(() => {
    const savedMember = window.localStorage.getItem('splitmate-payer');
    if (savedMember && members.some((member) => member.name === savedMember)) setActiveMember(savedMember);
    fetch('/api/expenses').then((response) => response.ok ? response.json() : null).then((data) => {
      if (Array.isArray(data?.expenses)) setExpenses(data.expenses);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    window.localStorage.setItem('splitmate-payer', activeMember);
  }, [activeMember]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'start_receipt_creation',
      title: 'Add a household receipt',
      description: 'Open the receipt capture flow for the currently selected household payer.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: () => { openCapture(); return { status: 'capture_opened', payer: activeMember }; },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [activeMember]);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200); };
  const openCapture = () => fileRef.current?.click();
  const handleFile = (file?: File) => {
    if (!file) return;
    setDraft({ merchant: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '), amount: '', category: 'Groceries', image: URL.createObjectURL(file), file });
    setSheetOpen(true);
  };
  const saveExpense = async () => {
    const amount = Number(draft.amount);
    if (!draft.merchant.trim() || !Number.isFinite(amount) || amount <= 0) return;
    const optimistic: Expense = { id: Date.now(), merchant: draft.merchant.trim(), amount, category: draft.category, payer: activeMember, date: 'Just now', image: draft.image };
    setExpenses((current) => [optimistic, ...current]);
    setSheetOpen(false);
    setDraft({ merchant: '', amount: '', category: 'Groceries', image: '', file: null });
    notify('Receipt added');
    const form = new FormData();
    form.set('merchant', optimistic.merchant);
    form.set('amount', String(optimistic.amount));
    form.set('category', optimistic.category);
    form.set('payer', optimistic.payer);
    if (draft.file) form.set('image', draft.file);
    try {
      const response = await fetch('/api/expenses', { method: 'POST', body: form });
      if (!response.ok) return;
      const data = await response.json();
      if (data.expense) setExpenses((current) => current.map((item) => item.id === optimistic.id ? data.expense : item));
    } catch { /* The optimistic receipt remains available for this session. */ }
  };
  const settlementText = `📊 *Household Settlement Report*\nTotal Pool Spent: ${money.format(total)}\nPer Person: ${money.format(share)}\n\n*Payments Needed:*\n${balances.filter((member) => member.paid < share - 0.01).map((member) => `• *${member.name}* owes ${money.format(share - member.paid)}`).join('\n')}`;

  return (
    <main className="min-h-dvh bg-[#eef0f4] text-[#172033]">
      <input ref={fileRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={(event) => handleFile(event.target.files?.[0])} />
      <div className="mx-auto min-h-dvh max-w-[1120px] pb-28 md:px-7 md:py-7">
        <div className="overflow-hidden bg-[#f7f7f9] shadow-[0_24px_80px_rgba(32,42,67,.14)] md:min-h-[calc(100dvh-56px)] md:rounded-[36px]">
          <header className="flex items-center justify-between px-5 pb-3 pt-[max(18px,env(safe-area-inset-top))] md:px-8 md:pt-7">
            <div><p className="text-[13px] font-semibold tracking-tight text-[#7a8190]">HOME HOUSEHOLD</p><h1 className="mt-0.5 text-[30px] font-[750] leading-none tracking-[-0.045em]">Good morning.</h1></div>
            <button className="ios-icon-button" aria-label="More options"><MoreHorizontal size={21} /></button>
          </header>

          <div className="grid gap-5 px-4 pb-5 pt-3 md:grid-cols-[1.08fr_.92fr] md:px-7 md:pb-8">
            <section className="space-y-5">
              <div className="balance-card">
                <div className="flex items-start justify-between"><div><p className="text-sm font-semibold text-white/55">September cycle</p><p className="mt-2 text-[42px] font-[750] leading-none tracking-[-0.055em] text-white">{money.format(total)}</p><p className="mt-2 text-sm font-medium text-white/55">{money.format(share)} each · {expenses.length} receipts</p></div><span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/75">Live</span></div>
                <div className="mt-7 flex items-end justify-between"><div className="flex -space-x-2">{members.map((member) => <span key={member.name} className="ring-2 ring-[#182033]"><Avatar member={member} small /></span>)}</div><button onClick={() => setTab('settle')} className="flex min-h-11 items-center gap-2 rounded-full bg-[#d8ff7e] px-4 text-sm font-bold text-[#172033]">Settle up <ArrowRight size={16} /></button></div>
              </div>

              <div><div className="mb-3 flex items-center justify-between px-1"><h2 className="section-title">Who paid?</h2><span className="text-xs font-semibold text-[#8a909c]">Tap to switch</span></div><div className="grid grid-cols-4 gap-2.5">{members.map((member) => <button key={member.name} onClick={() => setActiveMember(member.name)} className={`member-chip ${activeMember === member.name ? 'member-chip-active' : ''}`}><Avatar member={member} /><span className="mt-2 text-xs font-bold">{member.name}</span>{activeMember === member.name && <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-[#172033] text-white"><Check size={12} strokeWidth={3} /></span>}</button>)}</div></div>

              <button onClick={openCapture} className="capture-button"><span className="grid h-11 w-11 place-items-center rounded-full bg-white/14"><Camera size={21} /></span><span className="text-left"><span className="block text-base font-bold">Snap a receipt</span><span className="block text-xs font-medium text-white/60">We’ll prepare the details for you</span></span><ChevronRight className="ml-auto" size={20} /></button>
            </section>

            <section className={tab === 'home' ? 'block' : 'hidden md:block'}>
              <div className="mb-3 flex items-center justify-between px-1"><h2 className="section-title">Recent activity</h2><button className="text-sm font-bold text-[#5363d8]">See all</button></div>
              <div className="activity-card">
                {expenses.length === 0 ? <div className="grid min-h-64 place-items-center px-8 text-center"><div><ReceiptText className="mx-auto mb-3 text-[#a3a8b3]" /><p className="font-bold">No receipts yet</p><p className="mt-1 text-sm text-[#888f9c]">Snap your first receipt to start the cycle.</p></div></div> : expenses.slice(0, 5).map((expense, index) => {
                  const member = members.find((item) => item.name === expense.payer) ?? members[0];
                  return <article key={expense.id} className={`receipt-row ${index ? 'border-t border-[#eceef2]' : ''}`}>{expense.image ? <img src={expense.image} alt="Receipt preview" className="h-12 w-12 rounded-2xl object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#f0f1f5] text-[#667080]"><ReceiptText size={20} /></div>}<div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold">{expense.merchant}</h3><p className="mt-0.5 truncate text-xs font-medium text-[#8a909c]">{expense.category} · {expense.date}</p></div><div className="text-right"><p className="font-bold">{money.format(expense.amount)}</p><div className="mt-1 flex items-center justify-end gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: member.color }} /><span className="text-[11px] font-semibold text-[#8a909c]">{expense.payer}</span></div></div><button onClick={() => { setExpenses((current) => current.filter((item) => item.id !== expense.id)); void fetch(`/api/expenses?id=${encodeURIComponent(String(expense.id))}`, { method: 'DELETE' }); notify('Receipt removed'); }} className="delete-receipt" aria-label={`Delete ${expense.merchant}`}><X size={14} /></button></article>;
                })}
              </div>
            </section>

            <section className={`${tab === 'settle' ? 'block' : 'hidden'} md:col-span-2`}>
              <div className="mb-3 flex items-center justify-between px-1"><h2 className="section-title">This cycle</h2><span className="text-xs font-semibold text-[#8a909c]">Fair share · {money.format(share)}</span></div>
              <div className="grid gap-3 md:grid-cols-4">{balances.map((member) => { const net = member.paid - share; return <div key={member.name} className="settle-person"><div className="flex items-center gap-3"><Avatar member={member} small /><div><p className="text-sm font-bold">{member.name}</p><p className="text-xs text-[#8a909c]">Paid {money.format(member.paid)}</p></div></div><p className={`mt-5 text-lg font-bold ${net >= 0 ? 'text-[#16805d]' : 'text-[#dc5d57]'}`}>{net >= 0 ? '+' : '−'}{money.format(Math.abs(net))}</p><p className="mt-0.5 text-xs font-semibold text-[#8a909c]">{net >= 0 ? 'is owed' : 'owes the group'}</p></div>; })}</div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2"><button onClick={async () => { await navigator.clipboard.writeText(settlementText); notify('Settlement copied'); }} className="secondary-action"><Copy size={18} /> Copy for WhatsApp</button><button onClick={() => { setExpenses([]); void fetch('/api/expenses', { method: 'PATCH' }); notify('Cycle settled'); }} className="secondary-action text-[#dc5d57]"><Check size={18} /> Mark all as settled</button></div>
            </section>
          </div>
        </div>
      </div>

      <nav className="bottom-nav" aria-label="Primary navigation"><button onClick={() => setTab('home')} className={tab === 'home' ? 'nav-active' : ''}><Home size={20} /><span>Home</span></button><button onClick={() => setTab('settle')} className={tab === 'settle' ? 'nav-active' : ''}><PieChart size={20} /><span>Settle</span></button><button onClick={openCapture} className="nav-camera" aria-label="Snap receipt"><Camera size={23} /></button><button onClick={() => notify('Four members in Home')}><Users size={20} /><span>People</span></button><button onClick={() => notify('Settings coming soon')}><Settings size={20} /><span>Settings</span></button></nav>

      {sheetOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSheetOpen(false); }}><section className="receipt-sheet" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-[#d8dbe1]" /><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[.1em] text-[#6772d9]">Ready to review</p><h2 id="receipt-title" className="mt-1 text-2xl font-[750] tracking-[-.035em]">Receipt details</h2></div><button onClick={() => setSheetOpen(false)} className="ios-icon-button" aria-label="Close"><X size={18} /></button></div>{draft.image && <img src={draft.image} alt="Selected receipt" className="mt-5 h-28 w-full rounded-[20px] object-cover" />}<div className="mt-5 space-y-3"><label className="field-label">Merchant<input autoFocus value={draft.merchant} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} className="field-input" placeholder="Store name" /></label><div className="grid grid-cols-2 gap-3"><label className="field-label">Total (AUD)<input inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} className="field-input" placeholder="0.00" /></label><label className="field-label">Category<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="field-input"><option>Groceries</option><option>Utilities</option><option>Household</option><option>Dining</option><option>Other</option></select></label></div><div className="flex items-center justify-between rounded-2xl bg-[#f1f2f6] px-4 py-3"><div className="flex items-center gap-2"><ArrowDownLeft size={17} className="text-[#6772d9]" /><span className="text-sm font-semibold">Paid by {activeMember}</span></div><button onClick={() => setSheetOpen(false)} className="text-xs font-bold text-[#6772d9]">Change</button></div><button onClick={saveExpense} disabled={!draft.merchant.trim() || !(Number(draft.amount) > 0)} className="save-button">Add receipt <ArrowRight size={18} /></button></div></section></div>}
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </main>
  );
}
