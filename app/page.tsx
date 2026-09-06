'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Camera, Check, ChevronRight, Copy, Home, ImagePlus, LogOut, Mail, ReceiptText, RefreshCw, Search, Share2, Trash2, Users, WifiOff, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { fileToBase64, prepareReceiptImage } from '@/lib/receipt-image';
import { calculateTransfers, type Transfer } from '@/lib/settlements';

type Household = { id: string; name: string; join_code: string };
type Member = { id: string; household_id: string; user_id: string; name: string; color: string };
type Expense = { id: string; householdId: string; payerId: string; payerName: string; merchant: string; amount: number; category: string; receiptDate: string; createdAt: string; image?: string; imagePath?: string; settled: boolean; ocrStatus: string; ocrModel?: string };
type Cycle = { id: string; settled_at: string; total_amount: number; member_count: number; transfers: Transfer[] };
type Draft = { merchant: string; amount: string; category: string; receiptDate: string; payerId: string; image: string; file: File | null; ocrStatus: string; ocrProcessedAt: string | null; duplicate: boolean };
type ToastState = { message: string; action?: { label: string; run: () => void } };

declare global { interface Document { modelContext?: { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void> } } }

const categories = ['Groceries', 'Utilities', 'Household', 'Dining', 'Other'];
const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const blankDraft = (): Draft => ({ merchant: '', amount: '', category: 'Groceries', receiptDate: '', payerId: '', image: '', file: null, ocrStatus: 'not_requested', ocrProcessedAt: null, duplicate: false });

function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function Avatar({ member, small = false }: { member: Member; small?: boolean }) {
  const initials = member.name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return <span className={`avatar ${small ? 'avatar-small' : ''}`} style={{ background: member.color }} aria-hidden="true">{initials}</span>;
}

function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setStatus('');
    const result = mode === 'signin' ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
    setBusy(false);
    if (result.error) setStatus(result.error.message); else if (mode === 'signup' && !result.data.session) setStatus('Check your email to confirm your account.');
  };
  const resetPassword = async () => {
    if (!email) { setStatus('Enter your email address first.'); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    setStatus(error?.message ?? 'Password reset link sent.');
  };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><ReceiptText size={27} /></div><p className="eyebrow">SplitMate</p><h1>Household bills,<br />sorted.</h1><p className="auth-copy">Private receipts, automatic fair shares, and clear settlements.</p>{!supabaseConfigured ? <div className="auth-alert">Supabase is not connected yet.</div> : <form onSubmit={submit} className="auth-form"><label className="auth-field"><Mail size={18} /><input aria-label="Email address" required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Email address" /></label><label className="auth-field"><input aria-label="Password" required minLength={6} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" /></label>{status && <output className="auth-alert">{status}</output>}<button disabled={busy} className="primary-button">{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'} <ArrowRight size={17} /></button></form>}<button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setStatus(''); }} className="text-button">{mode === 'signin' ? 'Create an account' : 'Already have an account? Sign in'}</button>{mode === 'signin' && <button onClick={() => void resetPassword()} className="text-button muted">Forgot password?</button>}</section></main>;
}

function HouseholdSetup({ user, onReady }: { user: User; onReady: () => void }) {
  const [memberName, setMemberName] = useState(user.email?.split('@')[0] ?? 'Me');
  const [householdName, setHouseholdName] = useState('Home');
  const [joinCode, setJoinCode] = useState('');
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setStatus('');
    const result = mode === 'create' ? await supabase.rpc('create_household', { household_name: householdName, member_name: memberName }) : await supabase.rpc('join_household', { code: joinCode, member_name: memberName });
    setBusy(false); if (result.error) setStatus(result.error.message); else onReady();
  };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-mark"><Users size={26} /></div><p className="eyebrow">One quick step</p><h1>{mode === 'create' ? 'Create your household.' : 'Join your household.'}</h1><p className="auth-copy">Everyone in the household shares every expense equally.</p><form onSubmit={submit} className="auth-form"><label className="field-label">Your name<input required maxLength={50} className="field-input" value={memberName} onChange={(event) => setMemberName(event.target.value)} /></label>{mode === 'create' ? <label className="field-label">Household name<input required maxLength={60} className="field-input" value={householdName} onChange={(event) => setHouseholdName(event.target.value)} /></label> : <label className="field-label">8-character join code<input required maxLength={8} autoCapitalize="characters" className="field-input code-input" value={joinCode} onChange={(event) => setJoinCode(event.target.value.toUpperCase())} /></label>}{status && <output className="auth-alert">{status}</output>}<button disabled={busy} className="primary-button">{busy ? 'Please wait…' : mode === 'create' ? 'Create household' : 'Join household'}</button></form><button className="text-button" onClick={() => { setMode(mode === 'create' ? 'join' : 'create'); setStatus(''); }}>{mode === 'create' ? 'I have a join code' : 'Create a new household'}</button></section></main>;
}

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [household, setHousehold] = useState<Household | null>(null);
  const [self, setSelf] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [tab, setTab] = useState<'home' | 'receipts' | 'household'>('home');
  const [receiptFilter, setReceiptFilter] = useState<'active' | 'settled'>('active');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [detail, setDetail] = useState<Expense | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const touchStart = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const pendingDelete = useRef<{ expense: Expense; timer: number } | null>(null);

  const notify = useCallback((message: string, action?: ToastState['action'], duration = 2800) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ message, action }); toastTimer.current = window.setTimeout(() => setToast(null), duration);
  }, []);

  const loadMembership = useCallback(async () => {
    if (!user) return;
    setLoading(true); setError('');
    const memberResult = await supabase.from('household_members').select('*').eq('user_id', user.id).limit(1).maybeSingle();
    if (memberResult.error) {
      const cached = window.localStorage.getItem(`splitmate-membership:${user.id}`);
      if (cached && !navigator.onLine) { const parsed = JSON.parse(cached) as { self: Member; household: Household }; setSelf(parsed.self); setHousehold(parsed.household); }
      else setError(memberResult.error.message);
      setLoading(false); return;
    }
    if (!memberResult.data) { setSelf(null); setHousehold(null); setLoading(false); return; }
    const householdResult = await supabase.from('households').select('*').eq('id', memberResult.data.household_id).single();
    if (householdResult.error) { setError(householdResult.error.message); setLoading(false); return; }
    setSelf(memberResult.data as Member); setHousehold(householdResult.data as Household);
    window.localStorage.setItem(`splitmate-membership:${user.id}`, JSON.stringify({ self: memberResult.data, household: householdResult.data }));
    setLoading(false);
  }, [user]);

  const loadData = useCallback(async () => {
    if (!household) return;
    setError('');
    const [memberResult, expenseResult, cycleResult] = await Promise.all([
      supabase.from('household_members').select('*').eq('household_id', household.id).order('joined_at'),
      supabase.from('expenses').select('*').eq('household_id', household.id).is('deleted_at', null).order('receipt_date', { ascending: false }).limit(200),
      supabase.from('settlement_cycles').select('*').eq('household_id', household.id).order('settled_at', { ascending: false }).limit(12),
    ]);
    const firstError = memberResult.error ?? expenseResult.error ?? cycleResult.error;
    if (firstError) {
      const cached = window.localStorage.getItem(`splitmate-data:${household.id}`);
      if (cached && !navigator.onLine) { const parsed = JSON.parse(cached) as { members: Member[]; expenses: Expense[]; cycles: Cycle[] }; setMembers(parsed.members); setExpenses(parsed.expenses); setCycles(parsed.cycles); }
      else setError(firstError.message);
      return;
    }
    const loadedMembers = (memberResult.data ?? []) as Member[];
    const rows = expenseResult.data ?? [];
    const paths = rows.flatMap((row) => row.image_path ? [row.image_path] : []);
    const signed = paths.length ? await supabase.storage.from('receipts').createSignedUrls(paths, 3600) : { data: [] };
    const urls = new Map((signed.data ?? []).map((item) => [item.path, item.signedUrl]));
    const loadedExpenses = rows.map((row) => ({ id: row.id, householdId: row.household_id, payerId: row.payer_member_id, payerName: loadedMembers.find((member) => member.id === row.payer_member_id)?.name ?? row.payer ?? 'Member', merchant: row.merchant, amount: Number(row.amount), category: row.category, receiptDate: row.receipt_date ?? row.created_at.slice(0, 10), createdAt: row.created_at, image: row.image_path ? urls.get(row.image_path) ?? undefined : undefined, imagePath: row.image_path ?? undefined, settled: Boolean(row.settled), ocrStatus: row.ocr_status ?? 'not_requested', ocrModel: row.ocr_model ?? undefined }));
    const loadedCycles = (cycleResult.data ?? []).map((cycle) => ({ ...cycle, total_amount: Number(cycle.total_amount), transfers: Array.isArray(cycle.transfers) ? cycle.transfers : [] })) as Cycle[];
    setMembers(loadedMembers); setExpenses(loadedExpenses); setCycles(loadedCycles);
    window.localStorage.setItem(`splitmate-data:${household.id}`, JSON.stringify({ members: loadedMembers, expenses: loadedExpenses, cycles: loadedCycles }));
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const deleted = await supabase.from('expenses').select('id,image_path').eq('household_id', household.id).not('deleted_at', 'is', null).lt('deleted_at', cutoff);
    for (const row of deleted.data ?? []) {
      const storageResult = row.image_path ? await supabase.storage.from('receipts').remove([row.image_path]) : { error: null };
      if (!storageResult.error) await supabase.from('expenses').delete().eq('id', row.id);
    }
  }, [household]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user ?? null); setAuthLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { setUser(session?.user ?? null); setAuthLoading(false); });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    const goOnline = () => { setOnline(true); setRefreshKey((value) => value + 1); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline); window.addEventListener('offline', goOffline);
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js');
    return () => { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); };
  }, []);
  useEffect(() => { void loadMembership(); }, [loadMembership]);
  useEffect(() => { void loadData(); }, [loadData, refreshKey]);
  useEffect(() => {
    if (!household) return;
    const channel = supabase.channel(`household:${household.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).on('postgres_changes', { event: '*', schema: 'public', table: 'household_members', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).on('postgres_changes', { event: '*', schema: 'public', table: 'settlement_cycles', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [household]);

  const activeExpenses = useMemo(() => expenses.filter((expense) => !expense.settled), [expenses]);
  const total = useMemo(() => activeExpenses.reduce((sum, expense) => sum + expense.amount, 0), [activeExpenses]);
  const share = members.length ? total / members.length : 0;
  const transfers = useMemo(() => calculateTransfers(members, activeExpenses.map((expense) => ({ amount: expense.amount, payerId: expense.payerId }))), [members, activeExpenses]);
  const filteredExpenses = useMemo(() => expenses.filter((expense) => expense.settled === (receiptFilter === 'settled') && `${expense.merchant} ${expense.category} ${expense.payerName}`.toLowerCase().includes(search.trim().toLowerCase())), [expenses, receiptFilter, search]);
  const now = new Date();
  const greeting = now.getHours() < 12 ? 'Good morning.' : now.getHours() < 18 ? 'Good afternoon.' : 'Good evening.';
  const cycleLabel = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(now);

  const openUpload = useCallback(() => { if (!online) notify('Connect to the internet to scan a bill'); else uploadRef.current?.click(); }, [online, notify]);
  const openCamera = useCallback(() => { if (!online) notify('Connect to the internet to scan a bill'); else cameraRef.current?.click(); }, [online, notify]);
  const closeEditor = () => { if (draft.image.startsWith('blob:')) URL.revokeObjectURL(draft.image); setSheetOpen(false); setDetail(null); setDraft(blankDraft()); setSwipedId(null); };
  const scanFile = async (file: File) => {
    setAnalyzing(true);
    try {
      const imageBase64 = await fileToBase64(file);
      const { data, error: scanError } = await supabase.functions.invoke('scan-receipt', { body: { imageBase64, mimeType: file.type } });
      if (scanError) throw scanError; if (data?.error) throw new Error(data.error);
      setDraft((current) => {
        const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(data.receipt_date ?? '') ? data.receipt_date : current.receiptDate;
        const amount = data.total_amount ? String(data.total_amount) : current.amount;
        const merchant = data.merchant || current.merchant;
        return { ...current, merchant, amount, receiptDate, category: categories.includes(data.category) ? data.category : 'Other', ocrStatus: 'complete', ocrProcessedAt: new Date().toISOString(), duplicate: expenses.some((expense) => expense.receiptDate === receiptDate && expense.merchant.toLowerCase() === merchant.toLowerCase() && Math.abs(expense.amount - Number(amount)) < 0.01) };
      });
    } catch (scanError) { setDraft((current) => ({ ...current, ocrStatus: 'failed', ocrProcessedAt: new Date().toISOString() })); notify(scanError instanceof Error ? scanError.message : 'Scanning failed — enter the details manually'); }
    finally { setAnalyzing(false); }
  };
  const handleFile = async (original?: File) => {
    if (!original) return;
    try {
      const file = await prepareReceiptImage(original);
      const image = URL.createObjectURL(file);
      setDraft({ ...blankDraft(), merchant: original.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '), receiptDate: localDate(), payerId: self?.id ?? '', image, file, ocrStatus: 'pending' });
      setSheetOpen(true); setDetail(null); await scanFile(file);
    } catch (imageError) { notify(imageError instanceof Error ? imageError.message : 'Could not open that image'); }
    finally { if (uploadRef.current) uploadRef.current.value = ''; if (cameraRef.current) cameraRef.current.value = ''; }
  };
  const openDetail = (expense: Expense) => { setDetail(expense); setDraft({ ...blankDraft(), merchant: expense.merchant, amount: String(expense.amount), category: expense.category, receiptDate: expense.receiptDate, payerId: expense.payerId, image: expense.image ?? '', ocrStatus: expense.ocrStatus }); setSheetOpen(true); };
  const saveExpense = async () => {
    const amount = Number(draft.amount);
    if (!user || !household || !draft.payerId || !draft.merchant.trim() || !(amount > 0)) return;
    setSaving(true); let imagePath: string | null = detail?.imagePath ?? null; const expenseId = detail?.id ?? crypto.randomUUID();
    try {
      if (!detail && draft.file) { imagePath = `${user.id}/${expenseId}.jpg`; const upload = await supabase.storage.from('receipts').upload(imagePath, draft.file, { contentType: 'image/jpeg', upsert: false }); if (upload.error) throw upload.error; }
      const payer = members.find((member) => member.id === draft.payerId);
      const payload = { household_id: household.id, payer_member_id: draft.payerId, payer: payer?.name ?? 'Member', merchant: draft.merchant.trim(), amount, category: draft.category, receipt_date: draft.receiptDate || null, verified_at: new Date().toISOString(), ocr_status: draft.ocrStatus === 'failed' ? 'manual' : draft.ocrStatus, ocr_processed_at: draft.ocrProcessedAt, ocr_model: draft.ocrStatus === 'complete' ? 'gemini-3.7-flash' : detail?.ocrModel ?? null };
      const result = detail ? await supabase.from('expenses').update(payload).eq('id', detail.id) : await supabase.from('expenses').insert({ ...payload, id: expenseId, user_id: user.id, currency: 'AUD', image_path: imagePath, image_original_name: draft.file?.name ?? null, image_mime_type: draft.file?.type ?? null, image_size_bytes: draft.file?.size ?? null });
      if (result.error) throw result.error;
      closeEditor(); setRefreshKey((value) => value + 1); notify(detail ? 'Receipt updated' : 'Receipt added');
    } catch (saveError) { if (!detail && imagePath) await supabase.storage.from('receipts').remove([imagePath]); notify(saveError instanceof Error ? saveError.message : 'Could not save receipt'); }
    finally { setSaving(false); }
  };
  const rescanDetail = async () => {
    if (draft.file) { await scanFile(draft.file); return; }
    if (!detail?.imagePath) return;
    const result = await supabase.storage.from('receipts').download(detail.imagePath);
    if (result.error) { notify(result.error.message); return; }
    await scanFile(new File([result.data], 'receipt.jpg', { type: result.data.type || 'image/jpeg' }));
  };
  const purgeExpense = async (expense: Expense) => { const storageResult = expense.imagePath ? await supabase.storage.from('receipts').remove([expense.imagePath]) : { error: null }; if (!storageResult.error) await supabase.from('expenses').delete().eq('id', expense.id); if (pendingDelete.current?.expense.id === expense.id) pendingDelete.current = null; };
  const deleteExpense = async (expense: Expense) => {
    if (pendingDelete.current) { window.clearTimeout(pendingDelete.current.timer); await purgeExpense(pendingDelete.current.expense); }
    const result = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', expense.id);
    if (result.error) { notify(result.error.message); return; }
    setExpenses((current) => current.filter((item) => item.id !== expense.id)); closeEditor();
    const undo = async () => { if (pendingDelete.current?.expense.id !== expense.id) return; window.clearTimeout(pendingDelete.current.timer); pendingDelete.current = null; const restored = await supabase.from('expenses').update({ deleted_at: null }).eq('id', expense.id); if (restored.error) notify(restored.error.message); else { setRefreshKey((value) => value + 1); notify('Receipt restored'); } };
    const timer = window.setTimeout(() => void purgeExpense(expense), 5200); pendingDelete.current = { expense, timer };
    notify('Receipt deleted', { label: 'Undo', run: () => void undo() }, 5000);
  };
  const settleCycle = async () => { if (!household || !activeExpenses.length) return; setSaving(true); const result = await supabase.rpc('settle_household', { target_household: household.id, transfer_summary: transfers }); setSaving(false); if (result.error) notify(result.error.message); else { setRefreshKey((value) => value + 1); notify('Cycle settled'); } };
  const shareSettlement = async () => { const text = `${household?.name ?? 'Household'} settlement\n${transfers.length ? transfers.map((transfer) => `${transfer.from} pays ${transfer.to} ${money.format(transfer.amount)}`).join('\n') : 'Everyone is even.'}`; if (navigator.share) await navigator.share({ title: 'SplitMate settlement', text }); else { await navigator.clipboard.writeText(text); notify('Settlement copied'); } };
  const receiptRow = (expense: Expense) => {
    const payer = members.find((member) => member.id === expense.payerId) ?? self; const isOpen = !expense.settled && swipedId === expense.id;
    return <div className={`swipe-shell ${expense.settled ? 'swipe-disabled' : ''}`} key={expense.id}>{!expense.settled && <button className="swipe-delete" onClick={() => void deleteExpense(expense)} aria-label={`Delete ${expense.merchant}`}><Trash2 size={19} /><span>Delete</span></button>}<button className={`receipt-row ${isOpen ? 'receipt-row-swiped' : ''}`} onTouchStart={(event) => { touchStart.current = event.touches[0].clientX; }} onTouchEnd={(event) => { if (expense.settled) return; const distance = event.changedTouches[0].clientX - touchStart.current; if (distance < -45) setSwipedId(expense.id); if (distance > 35) setSwipedId(null); }} onClick={() => { if (isOpen) setSwipedId(null); else openDetail(expense); }}><div className="receipt-thumb">{expense.image ? <img src={expense.image} alt="" /> : <ReceiptText size={21} />}</div><div className="receipt-main"><h3>{expense.merchant}</h3><p>{expense.category} · {new Date(`${expense.receiptDate}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}</p></div><div className="receipt-amount"><strong>{money.format(expense.amount)}</strong><span>{payer && <i style={{ background: payer.color }} />}{expense.payerName}</span></div><ChevronRight size={17} className="row-chevron" /></button></div>;
  };

  useEffect(() => {
    const context = document.modelContext; if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({ name: 'start_receipt_creation', title: 'Add a household receipt', description: 'Open Photos to choose and scan a household bill.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => { openUpload(); return { status: 'photo_picker_opened' }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [openUpload]);

  if (authLoading) return <main className="loading-screen"><div className="auth-mark"><ReceiptText size={27} /></div><span className="loader" /><p>Opening SplitMate…</p></main>;
  if (!user) return <AuthScreen />;
  if (loading) return <main className="loading-screen"><div className="auth-mark"><ReceiptText size={27} /></div><span className="loader" /><p>Loading your household…</p></main>;
  if (!household || !self) return <HouseholdSetup user={user} onReady={() => void loadMembership()} />;

  return <main className="app-shell">
    <input ref={uploadRef} className="hidden" type="file" accept="image/*" onChange={(event) => void handleFile(event.target.files?.[0])} />
    <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={(event) => void handleFile(event.target.files?.[0])} />
    {!online && <div className="network-banner"><WifiOff size={15} /> Offline · showing saved data</div>}
    <div className="app-frame"><header className="topbar"><div><p>{household.name}</p><h1>{tab === 'home' ? greeting : tab === 'receipts' ? 'Receipts' : 'Household'}</h1></div><button onClick={openUpload} className="circle-button" aria-label="Choose bill from Photos"><ImagePlus size={21} /></button></header>{error && <div className="error-banner"><span>{error}</span><button onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>}
      {tab === 'home' && <div className="content-grid"><section className="stack"><div className="balance-card"><p>{cycleLabel}</p><strong>{money.format(total)}</strong><span>{money.format(share)} each · {activeExpenses.length} receipts</span><div className="member-stack">{members.map((member) => <Avatar key={member.id} member={member} small />)}</div></div><div className="source-actions"><button className="capture-button" onClick={openUpload}><ImagePlus size={22} /><span><strong>Choose bill from Photos</strong><small>Scanning image fills in the details</small></span><ChevronRight size={20} /></button><button className="camera-button" onClick={openCamera}><Camera size={18} /> Scan with camera</button></div><section><div className="section-heading"><h2>Recent receipts</h2><button onClick={() => setTab('receipts')}>See all</button></div><div className="list-card">{activeExpenses.length ? activeExpenses.slice(0, 5).map(receiptRow) : <div className="empty-state"><ReceiptText /><strong>No bills this cycle</strong><p>Choose one from Photos to get started.</p></div>}</div></section></section><section className="stack"><div className="section-heading"><h2>Settle up</h2><span>{members.length} people</span></div><div className="settlement-card">{!activeExpenses.length ? <div className="empty-state compact"><Check /><strong>Everything is settled</strong></div> : transfers.length ? transfers.map((transfer) => <div className="transfer-row" key={`${transfer.fromId}-${transfer.toId}`}><span><strong>{transfer.from}</strong> pays {transfer.to}</span><b>{money.format(transfer.amount)}</b></div>) : <div className="empty-state compact"><Check /><strong>Everyone is even</strong></div>}<div className="settlement-actions"><button disabled={!activeExpenses.length || saving} onClick={() => void shareSettlement()}><Share2 size={18} /> Share</button><button disabled={!activeExpenses.length || saving} onClick={() => void settleCycle()}><Check size={18} /> {saving ? 'Saving…' : 'Mark settled'}</button></div></div>{cycles.length > 0 && <section><div className="section-heading"><h2>Settlement history</h2></div><div className="list-card">{cycles.slice(0, 4).map((cycle) => <div className="history-row expanded" key={cycle.id}><div><strong>{new Date(cycle.settled_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}</strong><span>{cycle.member_count} people · {cycle.transfers.length} transfers</span>{cycle.transfers.map((transfer) => <small key={`${transfer.fromId}-${transfer.toId}`}>{transfer.from} → {transfer.to} · {money.format(transfer.amount)}</small>)}</div><b>{money.format(cycle.total_amount)}</b></div>)}</div></section>}</section></div>}
      {tab === 'receipts' && <section className="single-column"><label className="search-field"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search merchant, category or person" /></label><div className="segmented"><button className={receiptFilter === 'active' ? 'selected' : ''} onClick={() => setReceiptFilter('active')}>Current</button><button className={receiptFilter === 'settled' ? 'selected' : ''} onClick={() => setReceiptFilter('settled')}>History</button></div><div className="list-card">{filteredExpenses.length ? filteredExpenses.map(receiptRow) : <div className="empty-state"><Search /><strong>No matching receipts</strong><p>Try a different search.</p></div>}</div></section>}
      {tab === 'household' && <section className="single-column"><div className="invite-card"><div><p>Invite code</p><strong>{household.join_code}</strong><span>Share this code after someone creates an account.</span></div><button onClick={async () => { await navigator.clipboard.writeText(household.join_code); notify('Join code copied'); }}><Copy size={18} /> Copy</button></div><div className="section-heading"><h2>Members</h2><span>Every bill is split equally</span></div><div className="list-card">{members.map((member) => <div className="member-row" key={member.id}><Avatar member={member} /><div><strong>{member.name}</strong><span>{member.user_id === self.user_id ? 'You' : 'Household member'}</span></div></div>)}</div><button className="signout-button" onClick={() => void supabase.auth.signOut()}><LogOut size={18} /> Sign out</button></section>}
    </div>
    <nav className="bottom-nav" aria-label="Primary navigation"><button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}><Home size={21} /><span>Home</span></button><button className={tab === 'receipts' ? 'active' : ''} onClick={() => setTab('receipts')}><ReceiptText size={21} /><span>Receipts</span></button><button className={tab === 'household' ? 'active' : ''} onClick={() => setTab('household')}><Users size={21} /><span>Household</span></button></nav>
    {sheetOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeEditor(); }}><dialog open className="receipt-sheet" aria-labelledby="receipt-title"><div className="grabber" /><header><button className="sheet-close" onClick={closeEditor} disabled={saving}><X /></button><div><p>{detail ? 'Receipt details' : analyzing ? 'Scanning image' : 'Review details'}</p><h2 id="receipt-title">{detail?.settled ? 'Settled receipt' : detail ? 'Edit receipt' : 'New receipt'}</h2></div>{detail && !detail.settled ? <button className="sheet-delete" onClick={() => void deleteExpense(detail)}><Trash2 size={18} /> Delete</button> : <span />}</header>{draft.image && <img className="receipt-preview" src={draft.image} alt="Selected receipt" />}{analyzing && <div className="scan-status"><span className="loader small" />Scanning image…</div>}{draft.duplicate && <div className="warning-banner">This looks like a receipt already saved.</div>}<div className="editor-fields"><label className="field-label">Merchant<input disabled={detail?.settled} className="field-input" value={draft.merchant} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} /></label><div className="two-columns"><label className="field-label">Total (AUD)<input disabled={detail?.settled} className="field-input" inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></label><label className="field-label">Category<select disabled={detail?.settled} className="field-input" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div><div className="two-columns"><label className="field-label">Receipt date<input disabled={detail?.settled} className="field-input" type="date" value={draft.receiptDate} onChange={(event) => setDraft({ ...draft, receiptDate: event.target.value })} /></label><label className="field-label">Paid by<select disabled={detail?.settled} className="field-input" value={draft.payerId} onChange={(event) => setDraft({ ...draft, payerId: event.target.value })}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div><p className="privacy-note">Scanning sends this image securely to the receipt-reading service. All household members share the expense equally.</p>{detail?.settled ? <div className="settled-note"><Check size={17} /> Included in a completed settlement</div> : <>{(draft.file || detail?.imagePath) && <button className="rescan-button" disabled={analyzing || saving} onClick={() => void rescanDetail()}><RefreshCw size={17} /> Scan image again</button>}<button className="primary-button" disabled={analyzing || saving || !draft.payerId || !draft.merchant.trim() || !(Number(draft.amount) > 0)} onClick={() => void saveExpense()}>{saving ? 'Saving…' : detail ? 'Save changes' : 'Add receipt'} {!saving && <ArrowRight size={18} />}</button></>}</div></dialog></div>}
    {toast && <div className="toast"><Check size={16} /><span>{toast.message}</span>{toast.action && <button onClick={toast.action.run}>{toast.action.label}</button>}</div>}
  </main>;
}
