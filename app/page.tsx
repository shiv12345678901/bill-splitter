'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowRight, Camera, Check, ChevronRight, Copy, Home, LockKeyhole, LogOut, Mail, PieChart, ReceiptText, Settings, Users, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '@/lib/supabase';

type Member = { name: string; initials: string; color: string };
type Expense = { id: string; merchant: string; amount: number; category: string; payer: string; date: string; image?: string; imagePath?: string };
type OcrStatus = 'not_requested' | 'pending' | 'complete' | 'failed' | 'manual';
type Draft = { merchant: string; amount: string; category: string; receiptDate: string; image: string; file: File | null; ocrStatus: OcrStatus; ocrProcessedAt: string | null };

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

const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const categories = ['Groceries', 'Utilities', 'Household', 'Dining', 'Other'];
const allowedReceiptTypes = ['image/jpeg', 'image/png', 'image/webp'];
const maxReceiptBytes = 10 * 1024 * 1024;
const blankDraft = (): Draft => ({ merchant: '', amount: '', category: 'Groceries', receiptDate: '', image: '', file: null, ocrStatus: 'not_requested', ocrProcessedAt: null });

function todayForInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function Avatar({ member, small = false }: { member: Member; small?: boolean }) {
  return <span className={`grid shrink-0 place-items-center rounded-full font-bold text-[#172033] ${small ? 'h-9 w-9 text-[11px]' : 'h-12 w-12 text-xs'}`} style={{ background: member.color }} aria-hidden="true">{member.initials}</span>;
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    const result = mode === 'signin'
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    if (result.error) setStatus(result.error.message);
    else if (mode === 'signup' && !result.data.session) setStatus('Check your email to confirm your account.');
  };

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-mark"><ReceiptText size={26} /></div>
        <p className="mt-6 text-xs font-bold uppercase tracking-[.14em] text-[#6772d9]">SplitMate</p>
        <h1 className="mt-2 text-[34px] font-[780] leading-[1.02] tracking-[-.05em]">Household bills,<br />sorted.</h1>
        <p className="mt-3 max-w-sm text-sm leading-6 text-[#7b8290]">Sign in to keep your receipts, balances, and settlement history private and synced.</p>
        {!supabaseConfigured ? <div className="auth-alert">Supabase is not connected yet. Add the project URL and publishable key to continue.</div> : (
          <form onSubmit={submit} className="mt-7 space-y-3">
            <label className="auth-field"><Mail size={18} /><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" /></label>
            <label className="auth-field"><LockKeyhole size={18} /><input required minLength={6} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" /></label>
            {status && <p className="auth-alert" role="status">{status}</p>}
            <button disabled={busy} className="auth-submit">{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'} <ArrowRight size={17} /></button>
          </form>
        )}
        <button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setStatus(''); }} className="auth-switch">{mode === 'signin' ? 'New here? Create an account' : 'Already have an account? Sign in'}</button>
        <div className="mt-8 flex items-center gap-2 text-xs font-semibold text-[#9a9faa]"><span className="h-px flex-1 bg-[#e4e6ea]" />Private by default<span className="h-px flex-1 bg-[#e4e6ea]" /></div>
      </section>
    </main>
  );
}

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [activeMember, setActiveMember] = useState('Alex');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [tab, setTab] = useState<'home' | 'settle'>('home');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [toast, setToast] = useState('');
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const fileRef = useRef<HTMLInputElement>(null);
  const total = useMemo(() => expenses.reduce((sum, expense) => sum + expense.amount, 0), [expenses]);
  const share = total / members.length;
  const balances = useMemo(() => members.map((member) => ({ ...member, paid: expenses.filter((expense) => expense.payer === member.name).reduce((sum, expense) => sum + expense.amount, 0) })), [expenses]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user ?? null); setAuthLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { setUser(session?.user ?? null); setAuthLoading(false); });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const savedMember = window.localStorage.getItem('splitmate-payer');
    if (savedMember && members.some((member) => member.name === savedMember)) setActiveMember(savedMember);
  }, []);

  useEffect(() => {
    if (!user) { setExpenses([]); return; }
    const load = async () => {
      const { data } = await supabase.from('expenses').select('*').eq('settled', false).order('created_at', { ascending: false });
      if (!data) return;
      const imagePaths = data.flatMap((row) => row.image_path ? [row.image_path] : []);
      const signed = imagePaths.length ? await supabase.storage.from('receipts').createSignedUrls(imagePaths, 3600) : { data: [] };
      const imageUrls = new Map((signed.data ?? []).map((item) => [item.path, item.signedUrl]));
      const mapped = data.map((row) => ({
        id: row.id,
        merchant: row.merchant,
        amount: Number(row.amount),
        category: row.category,
        payer: row.payer,
        date: row.receipt_date
          ? new Date(`${row.receipt_date}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
          : new Date(row.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
        image: row.image_path ? imageUrls.get(row.image_path) ?? undefined : undefined,
        imagePath: row.image_path ?? undefined,
      } satisfies Expense));
      setExpenses(mapped);
    };
    void load();
  }, [user, refreshKey]);

  useEffect(() => {
    if (!user) return;
    const channel = supabase.channel(`expenses:${user.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `user_id=eq.${user.id}` }, () => setRefreshKey((current) => current + 1)).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [user]);

  useEffect(() => {
    const refreshImages = () => {
      if (document.visibilityState === 'visible') setRefreshKey((current) => current + 1);
    };
    window.addEventListener('focus', refreshImages);
    document.addEventListener('visibilitychange', refreshImages);
    return () => {
      window.removeEventListener('focus', refreshImages);
      document.removeEventListener('visibilitychange', refreshImages);
    };
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
  const closeSheet = () => {
    if (draft.image.startsWith('blob:')) URL.revokeObjectURL(draft.image);
    setSheetOpen(false);
    setDraft(blankDraft());
  };
  const handleFile = async (file?: File) => {
    if (!file) return;
    if (!allowedReceiptTypes.includes(file.type)) {
      notify('Choose a JPG, PNG, or WebP receipt');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.size > maxReceiptBytes) {
      notify('Receipt images must be under 10 MB');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    const image = URL.createObjectURL(file);
    setDraft({ merchant: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '), amount: '', category: 'Groceries', receiptDate: todayForInput(), image, file, ocrStatus: 'pending', ocrProcessedAt: null });
    setSheetOpen(true);
    setAnalyzing(true);
    try {
      const imageBase64 = await fileToBase64(file);
      const { data, error } = await supabase.functions.invoke('scan-receipt', { body: { imageBase64, mimeType: file.type } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      setDraft((current) => ({
        ...current,
        merchant: data.merchant || current.merchant,
        amount: data.total_amount ? String(data.total_amount) : current.amount,
        category: categories.includes(data.category) ? data.category : 'Other',
        receiptDate: /^\d{4}-\d{2}-\d{2}$/.test(data.receipt_date ?? '') ? data.receipt_date : current.receiptDate,
        ocrStatus: 'complete',
        ocrProcessedAt: new Date().toISOString(),
      }));
      notify('Receipt scanned');
    } catch {
      setDraft((current) => ({ ...current, ocrStatus: 'failed', ocrProcessedAt: new Date().toISOString() }));
      notify('Scan unavailable — enter details manually');
    } finally {
      setAnalyzing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const saveExpense = async () => {
    const amount = Number(draft.amount);
    if (!user || !draft.merchant.trim() || !Number.isFinite(amount) || amount <= 0) return;
    setSaving(true);
    const expenseId = crypto.randomUUID();
    let imagePath: string | null = null;
    try {
      if (draft.file) {
        const extension = draft.file.type === 'image/png' ? 'png' : draft.file.type === 'image/webp' ? 'webp' : 'jpg';
        imagePath = `${user.id}/${expenseId}.${extension}`;
        const upload = await supabase.storage.from('receipts').upload(imagePath, draft.file, { contentType: draft.file.type, upsert: false });
        if (upload.error) throw upload.error;
      }
      const result = await supabase.from('expenses').insert({
        id: expenseId,
        user_id: user.id,
        merchant: draft.merchant.trim(),
        amount,
        category: draft.category,
        payer: activeMember,
        receipt_date: draft.receiptDate || null,
        currency: 'AUD',
        image_path: imagePath,
        image_original_name: draft.file?.name ?? null,
        image_mime_type: draft.file?.type ?? null,
        image_size_bytes: draft.file?.size ?? null,
        ocr_model: draft.ocrStatus === 'complete' ? 'gemini-3.7-flash' : null,
        ocr_status: draft.ocrStatus === 'failed' ? 'manual' : draft.ocrStatus,
        ocr_processed_at: draft.ocrProcessedAt,
        verified_at: new Date().toISOString(),
      });
      if (result.error) throw result.error;
      closeSheet();
      setRefreshKey((current) => current + 1);
      notify('Receipt added');
    } catch (error) {
      if (imagePath) await supabase.storage.from('receipts').remove([imagePath]);
      notify(error instanceof Error ? error.message : 'Could not save receipt');
    } finally {
      setSaving(false);
    }
  };
  const removeExpense = async (expense: Expense) => {
    const result = await supabase.from('expenses').delete().eq('id', expense.id);
    if (result.error) {
      notify(result.error.message);
      return;
    }
    setExpenses((current) => current.filter((item) => item.id !== expense.id));
    if (expense.imagePath) {
      const cleanup = await supabase.storage.from('receipts').remove([expense.imagePath]);
      if (cleanup.error) {
        notify('Receipt removed, but image cleanup failed');
        return;
      }
    }
    notify('Receipt removed');
  };
  const settlementText = `📊 *Household Settlement Report*\nTotal Pool Spent: ${money.format(total)}\nPer Person: ${money.format(share)}\n\n*Payments Needed:*\n${balances.filter((member) => member.paid < share - 0.01).map((member) => `• *${member.name}* owes ${money.format(share - member.paid)}`).join('\n')}`;

  if (authLoading) return <main className="auth-shell"><div className="auth-mark animate-pulse"><ReceiptText size={26} /></div></main>;
  if (!user) return <AuthScreen />;

  return (
    <main className="min-h-dvh bg-[#eef0f4] text-[#172033]">
      <input ref={fileRef} className="hidden" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={(event) => void handleFile(event.target.files?.[0])} />
      <div className="mx-auto min-h-dvh max-w-[1120px] pb-28 md:px-7 md:py-7">
        <div className="overflow-hidden bg-[#f7f7f9] shadow-[0_24px_80px_rgba(32,42,67,.14)] md:min-h-[calc(100dvh-56px)] md:rounded-[36px]">
          <header className="flex items-center justify-between px-5 pb-3 pt-[max(18px,env(safe-area-inset-top))] md:px-8 md:pt-7">
            <div><p className="text-[13px] font-semibold tracking-tight text-[#7a8190]">HOME HOUSEHOLD</p><h1 className="mt-0.5 text-[30px] font-[750] leading-none tracking-[-0.045em]">Good morning.</h1></div>
            <button onClick={() => void supabase.auth.signOut()} className="ios-icon-button" aria-label="Sign out" title={user.email ?? 'Sign out'}><LogOut size={19} /></button>
          </header>

          <div className="grid gap-5 px-4 pb-5 pt-3 md:grid-cols-[1.08fr_.92fr] md:px-7 md:pb-8">
            <section className="space-y-5">
              <div className="balance-card">
                <div className="flex items-start justify-between"><div><p className="text-sm font-semibold text-white/55">September cycle</p><p className="mt-2 text-[42px] font-[750] leading-none tracking-[-0.055em] text-white">{money.format(total)}</p><p className="mt-2 text-sm font-medium text-white/55">{money.format(share)} each · {expenses.length} receipts</p></div><span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-white/75">Live</span></div>
                <div className="mt-7 flex items-end justify-between"><div className="flex -space-x-2">{members.map((member) => <span key={member.name} className="ring-2 ring-[#182033]"><Avatar member={member} small /></span>)}</div><button onClick={() => setTab('settle')} className="flex min-h-11 items-center gap-2 rounded-full bg-[#d8ff7e] px-4 text-sm font-bold text-[#172033]">Settle up <ArrowRight size={16} /></button></div>
              </div>

              <div><div className="mb-3 flex items-center justify-between px-1"><h2 className="section-title">Who paid?</h2><span className="text-xs font-semibold text-[#8a909c]">Tap to switch</span></div><div className="grid grid-cols-4 gap-2.5">{members.map((member) => <button key={member.name} onClick={() => setActiveMember(member.name)} className={`member-chip ${activeMember === member.name ? 'member-chip-active' : ''}`}><Avatar member={member} /><span className="mt-2 text-xs font-bold">{member.name}</span>{activeMember === member.name && <span className="absolute right-2 top-2 grid h-5 w-5 place-items-center rounded-full bg-[#172033] text-white"><Check size={12} strokeWidth={3} /></span>}</button>)}</div></div>

              <button onClick={openCapture} className="capture-button"><span className="grid h-11 w-11 place-items-center rounded-full bg-white/14"><Camera size={21} /></span><span className="text-left"><span className="block text-base font-bold">Snap a receipt</span><span className="block text-xs font-medium text-white/60">OCR reads the merchant, total, and category</span></span><ChevronRight className="ml-auto" size={20} /></button>
            </section>

            <section className={tab === 'home' ? 'block' : 'hidden md:block'}>
              <div className="mb-3 flex items-center justify-between px-1"><h2 className="section-title">Recent activity</h2><button className="text-sm font-bold text-[#5363d8]">See all</button></div>
              <div className="activity-card">
                {expenses.length === 0 ? <div className="grid min-h-64 place-items-center px-8 text-center"><div><ReceiptText className="mx-auto mb-3 text-[#a3a8b3]" /><p className="font-bold">No receipts yet</p><p className="mt-1 text-sm text-[#888f9c]">Snap your first receipt to start the cycle.</p></div></div> : expenses.slice(0, 5).map((expense, index) => {
                  const member = members.find((item) => item.name === expense.payer) ?? members[0];
                  return <article key={expense.id} className={`receipt-row ${index ? 'border-t border-[#eceef2]' : ''}`}>{expense.image ? <img src={expense.image} alt="Receipt preview" className="h-12 w-12 rounded-2xl object-cover" /> : <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#f0f1f5] text-[#667080]"><ReceiptText size={20} /></div>}<div className="min-w-0 flex-1"><h3 className="truncate text-[15px] font-bold">{expense.merchant}</h3><p className="mt-0.5 truncate text-xs font-medium text-[#8a909c]">{expense.category} · {expense.date}</p></div><div className="text-right"><p className="font-bold">{money.format(expense.amount)}</p><div className="mt-1 flex items-center justify-end gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: member.color }} /><span className="text-[11px] font-semibold text-[#8a909c]">{expense.payer}</span></div></div><button onClick={() => void removeExpense(expense)} className="delete-receipt" aria-label={`Delete ${expense.merchant}`}><X size={14} /></button></article>;
                })}
              </div>
            </section>

            <section className={`${tab === 'settle' ? 'block' : 'hidden'} md:col-span-2`}>
              <div className="mb-3 flex items-center justify-between px-1"><h2 className="section-title">This cycle</h2><span className="text-xs font-semibold text-[#8a909c]">Fair share · {money.format(share)}</span></div>
              <div className="grid gap-3 md:grid-cols-4">{balances.map((member) => { const net = member.paid - share; return <div key={member.name} className="settle-person"><div className="flex items-center gap-3"><Avatar member={member} small /><div><p className="text-sm font-bold">{member.name}</p><p className="text-xs text-[#8a909c]">Paid {money.format(member.paid)}</p></div></div><p className={`mt-5 text-lg font-bold ${net >= 0 ? 'text-[#16805d]' : 'text-[#dc5d57]'}`}>{net >= 0 ? '+' : '−'}{money.format(Math.abs(net))}</p><p className="mt-0.5 text-xs font-semibold text-[#8a909c]">{net >= 0 ? 'is owed' : 'owes the group'}</p></div>; })}</div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2"><button onClick={async () => { await navigator.clipboard.writeText(settlementText); notify('Settlement copied'); }} className="secondary-action"><Copy size={18} /> Copy for WhatsApp</button><button onClick={() => { setExpenses([]); void supabase.from('expenses').update({ settled: true }).eq('settled', false); notify('Cycle settled'); }} className="secondary-action text-[#dc5d57]"><Check size={18} /> Mark all as settled</button></div>
            </section>
          </div>
        </div>
      </div>

      <nav className="bottom-nav" aria-label="Primary navigation"><button onClick={() => setTab('home')} className={tab === 'home' ? 'nav-active' : ''}><Home size={20} /><span>Home</span></button><button onClick={() => setTab('settle')} className={tab === 'settle' ? 'nav-active' : ''}><PieChart size={20} /><span>Settle</span></button><button onClick={openCapture} className="nav-camera" aria-label="Snap receipt"><Camera size={23} /></button><button onClick={() => notify('Four members in Home')}><Users size={20} /><span>People</span></button><button onClick={() => notify('Settings coming soon')}><Settings size={20} /><span>Settings</span></button></nav>

      {sheetOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeSheet(); }}><section className="receipt-sheet" role="dialog" aria-modal="true" aria-labelledby="receipt-title"><div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-[#d8dbe1]" /><div className="flex items-start justify-between"><div><p className="text-xs font-bold uppercase tracking-[.1em] text-[#6772d9]">{analyzing ? 'Reading with Gemini OCR' : 'Ready to review'}</p><h2 id="receipt-title" className="mt-1 text-2xl font-[750] tracking-[-.035em]">Receipt details</h2></div><button disabled={saving} onClick={closeSheet} className="ios-icon-button" aria-label="Close"><X size={18} /></button></div>{draft.image && <img src={draft.image} alt="Selected receipt" className="mt-5 h-28 w-full rounded-[20px] object-cover" />}{analyzing && <div className="scan-status" role="status"><span className="scan-spinner" />Analyzing merchant, total, date, and category…</div>}<div className="mt-5 space-y-3"><label className="field-label">Merchant<input autoFocus={!analyzing} value={draft.merchant} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} className="field-input" placeholder="Store name" /></label><div className="grid grid-cols-2 gap-3"><label className="field-label">Total (AUD)<input inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} className="field-input" placeholder="0.00" /></label><label className="field-label">Category<select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} className="field-input">{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div><label className="field-label">Receipt date<input type="date" value={draft.receiptDate} onChange={(event) => setDraft({ ...draft, receiptDate: event.target.value })} className="field-input" /></label><div className="flex items-center justify-between rounded-2xl bg-[#f1f2f6] px-4 py-3"><div className="flex items-center gap-2"><ArrowDownLeft size={17} className="text-[#6772d9]" /><span className="text-sm font-semibold">Paid by {activeMember}</span></div><button disabled={saving} onClick={closeSheet} className="text-xs font-bold text-[#6772d9]">Change</button></div><button onClick={() => void saveExpense()} disabled={analyzing || saving || !draft.merchant.trim() || !(Number(draft.amount) > 0)} className="save-button">{analyzing ? 'Reading receipt…' : saving ? 'Saving receipt…' : 'Add receipt'} {!analyzing && !saving && <ArrowRight size={18} />}</button></div></section></div>}
      {toast && <div className="toast"><Check size={15} /> {toast}</div>}
    </main>
  );
}
