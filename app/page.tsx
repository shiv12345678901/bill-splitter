'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Camera, ChartNoAxesColumnIncreasing, Check, ChevronRight, Fingerprint, Home, ImagePlus, Link2, LogOut, Mail, Palette, Pencil, Plus, ReceiptText, RefreshCw, Search, Settings2, Share2, ShieldCheck, Trash2, UserMinus, Users, WifiOff, X } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { fileToBase64, prepareReceiptImage } from '@/lib/receipt-image';
import { calculateTransfers, type Transfer } from '@/lib/settlements';
import { getOfflineReceipts, removeOfflineReceipt, saveOfflineReceipt, type OfflineReceipt } from '@/lib/offline-receipts';

type Household = { id: string; name: string; join_code: string; created_by?: string };
type Member = { id: string; household_id: string; user_id: string; name: string; color: string };
type Expense = { id: string; householdId: string; payerId: string; payerName: string; merchant: string; amount: number; category: string; receiptDate: string; createdAt: string; image?: string; imagePath?: string; settled: boolean; ocrStatus: string; ocrModel?: string; notes?: string; syncStatus?: 'pending' };
type Cycle = { id: string; settled_at: string; total_amount: number; member_count: number; transfers: Transfer[] };
type Activity = { id: number; actor_name: string | null; summary: string; action: string; created_at: string };
type HouseholdCategory = { id: string; name: string };
type Draft = { merchant: string; amount: string; category: string; receiptDate: string; payerId: string; image: string; imagePath: string; scanJobId: string; file: File | null; notes: string; ocrStatus: string; ocrProcessedAt: string | null; duplicate: boolean; lowConfidence: boolean };
type ToastState = { message: string; action?: { label: string; run: () => void } };

declare global { interface Document { modelContext?: { registerTool: (tool: Record<string, unknown>, options?: { signal?: AbortSignal }) => void | Promise<void> } } }

const defaultCategories = ['Groceries', 'Utilities', 'Household', 'Dining', 'Other'];
const money = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const blankDraft = (): Draft => ({ merchant: '', amount: '', category: 'Groceries', receiptDate: '', payerId: '', image: '', imagePath: '', scanJobId: '', file: null, notes: '', ocrStatus: 'not_requested', ocrProcessedAt: null, duplicate: false, lowConfidence: false });

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
  const [emailName, setEmailName] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const email = `${emailName.trim()}@gmail.com`;
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setStatus('');
    const result = mode === 'signin' ? await supabase.auth.signInWithPassword({ email, password }) : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.href } });
    setBusy(false);
    if (result.error) setStatus(result.error.message); else if (mode === 'signup' && !result.data.session) setStatus('Check your email to confirm your account.');
  };
  const resetPassword = async () => {
    if (!emailName.trim()) { setStatus('Enter your Gmail username first.'); return; }
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
    setStatus(error?.message ?? 'Password reset link sent.');
  };
  const passkeySignIn = async () => {
    setBusy(true); setStatus('');
    try { const result = await supabase.auth.signInWithPasskey(); if (result.error) setStatus(result.error.message); }
    catch (passkeyError) { setStatus(passkeyError instanceof Error ? passkeyError.message : 'Passkey sign-in was cancelled.'); }
    finally { setBusy(false); }
  };
  const updateEmailName = (value: string) => setEmailName(value.trim().replace(/@gmail\.com$/i, '').replace(/@.*$/, ''));
  return <main className="auth-shell"><section className="auth-card intro-card"><img className="brand-logo" src="/app-icon.svg" alt="SplitMate" /><p className="eyebrow">SplitMate</p><h1>Scan. Split.<br />Settle.</h1><p className="auth-copy">The private household bill app designed to feel at home on your iPhone.</p><div className="intro-points"><span><ImagePlus size={17} /> Scan bills from Photos</span><span><Users size={17} /> Share every cost equally</span><span><ShieldCheck size={17} /> Private and securely synced</span></div>{!supabaseConfigured ? <div className="auth-alert">Supabase is not connected yet.</div> : <><form onSubmit={submit} className="auth-form"><label className="auth-field gmail-field"><Mail size={18} /><input aria-label="Gmail username" required type="text" inputMode="email" autoComplete="username" value={emailName} onChange={(event) => updateEmailName(event.target.value)} placeholder="yourname" /><span>@gmail.com</span></label><label className="auth-field"><input aria-label="Password" required minLength={6} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Password" /></label>{status && <output className="auth-alert">{status}</output>}<button disabled={busy} className="primary-button">{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'} <ArrowRight size={17} /></button></form>{mode === 'signin' && typeof PublicKeyCredential !== 'undefined' && <><div className="auth-divider"><span />or<span /></div><button disabled={busy} onClick={() => void passkeySignIn()} className="passkey-button"><Fingerprint size={21} /> Use Face ID or passkey</button></>}</>}<button onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setStatus(''); }} className="text-button">{mode === 'signin' ? 'Create an account' : 'Already have an account? Sign in'}</button>{mode === 'signin' && <button onClick={() => void resetPassword()} className="text-button muted">Forgot password?</button>}</section></main>;
}

function HouseholdSetup({ user, onReady }: { user: User; onReady: () => void }) {
  const invitedCode = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('join')?.toUpperCase() ?? '';
  const [memberName, setMemberName] = useState(user.email?.split('@')[0] ?? 'Me');
  const [householdName, setHouseholdName] = useState('Home');
  const [joinCode, setJoinCode] = useState(invitedCode);
  const [mode, setMode] = useState<'create' | 'join'>(invitedCode ? 'join' : 'create');
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
  const [activities, setActivities] = useState<Activity[]>([]);
  const [customCategories, setCustomCategories] = useState<HouseholdCategory[]>([]);
  const [tab, setTab] = useState<'home' | 'receipts' | 'insights' | 'household' | 'settings'>('home');
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() => typeof window === 'undefined' ? 'system' : (window.localStorage.getItem('splitmate-theme') as 'system' | 'light' | 'dark' | null) ?? 'system');
  const [receiptFilter, setReceiptFilter] = useState<'active' | 'settled'>('active');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Expense | null>(null);
  const [detail, setDetail] = useState<Expense | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [profileName, setProfileName] = useState('');
  const [householdName, setHouseholdName] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const touchStart = useRef(0);
  const sheetTouchStart = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const pendingDelete = useRef<{ expense: Expense; timer: number } | null>(null);
  const activeScan = useRef('');
  const cancelledScan = useRef('');

  const notify = useCallback((message: string, action?: ToastState['action'], duration = 2800) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ message, action }); toastTimer.current = window.setTimeout(() => setToast(null), duration);
  }, []);

  const loadMembership = useCallback(async () => {
    if (!user) return;
    const cached = window.localStorage.getItem(`splitmate-membership:${user.id}`);
    if (cached) {
      const parsed = JSON.parse(cached) as { self: Member; household: Household };
      setSelf(parsed.self); setHousehold(parsed.household); setProfileName(parsed.self.name); setHouseholdName(parsed.household.name); setLoading(false);
    } else setLoading(true);
    setError('');
    const memberResult = await supabase.from('household_members').select('*,households(id,name,join_code,created_by)').eq('user_id', user.id).is('left_at', null).limit(1).maybeSingle();
    if (memberResult.error) {
      if (cached && !navigator.onLine) { const parsed = JSON.parse(cached) as { self: Member; household: Household }; setSelf(parsed.self); setHousehold(parsed.household); }
      else setError(memberResult.error.message);
      setLoading(false); return;
    }
    if (!memberResult.data) { window.localStorage.removeItem(`splitmate-membership:${user.id}`); setSelf(null); setHousehold(null); setLoading(false); return; }
    const rawMember = memberResult.data as Member & { households: Household | Household[] };
    const loadedHousehold = Array.isArray(rawMember.households) ? rawMember.households[0] : rawMember.households;
    const { households: _households, ...loadedMember } = rawMember;
    if (!loadedHousehold) { setError('Household could not be loaded.'); setLoading(false); return; }
    setSelf(loadedMember); setHousehold(loadedHousehold); setProfileName(loadedMember.name); setHouseholdName(loadedHousehold.name);
    window.localStorage.setItem(`splitmate-membership:${user.id}`, JSON.stringify({ self: loadedMember, household: loadedHousehold }));
    setLoading(false);
  }, [user]);

  const loadData = useCallback(async () => {
    if (!household) return;
    setError('');
    const [memberResult, expenseResult, cycleResult, activityResult, categoryResult] = await Promise.all([
      supabase.from('household_members').select('*').eq('household_id', household.id).is('left_at', null).order('joined_at'),
      supabase.from('expenses').select('*').eq('household_id', household.id).is('deleted_at', null).order('receipt_date', { ascending: false }).limit(200),
      supabase.from('settlement_cycles').select('*').eq('household_id', household.id).order('settled_at', { ascending: false }).limit(12),
      supabase.from('household_activity').select('id,actor_name,summary,action,created_at').eq('household_id', household.id).order('created_at', { ascending: false }).limit(30),
      supabase.from('household_categories').select('id,name').eq('household_id', household.id).order('name'),
    ]);
    const firstError = memberResult.error ?? expenseResult.error ?? cycleResult.error ?? activityResult.error ?? categoryResult.error;
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
    const loadedExpenses = rows.map((row) => ({ id: row.id, householdId: row.household_id, payerId: row.payer_member_id, payerName: loadedMembers.find((member) => member.id === row.payer_member_id)?.name ?? row.payer ?? 'Member', merchant: row.merchant, amount: Number(row.amount), category: row.category, receiptDate: row.receipt_date ?? row.created_at.slice(0, 10), createdAt: row.created_at, image: row.image_path ? urls.get(row.image_path) ?? undefined : undefined, imagePath: row.image_path ?? undefined, settled: Boolean(row.settled), ocrStatus: row.ocr_status ?? 'not_requested', ocrModel: row.ocr_model ?? undefined, notes: row.notes ?? '' }));
    const loadedCycles = (cycleResult.data ?? []).map((cycle) => ({ ...cycle, total_amount: Number(cycle.total_amount), transfers: Array.isArray(cycle.transfers) ? cycle.transfers : [] })) as Cycle[];
    setMembers(loadedMembers); setExpenses(loadedExpenses); setCycles(loadedCycles); setActivities((activityResult.data ?? []) as Activity[]); setCustomCategories((categoryResult.data ?? []) as HouseholdCategory[]);
    window.localStorage.setItem(`splitmate-data:${household.id}`, JSON.stringify({ members: loadedMembers, expenses: loadedExpenses, cycles: loadedCycles }));
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const deleted = await supabase.from('expenses').select('id,image_path').eq('household_id', household.id).not('deleted_at', 'is', null).lt('deleted_at', cutoff);
    for (const row of deleted.data ?? []) {
      const storageResult = row.image_path ? await supabase.storage.from('receipts').remove([row.image_path]) : { error: null };
      if (!storageResult.error) await supabase.from('expenses').delete().eq('id', row.id);
    }
  }, [household]);

  const syncOfflineReceipts = useCallback(async () => {
    if (!online || !user || !household) return;
    const queued = (await getOfflineReceipts()).filter((receipt) => receipt.userId === user.id && receipt.householdId === household.id);
    let synced = 0;
    for (const receipt of queued) {
      let imagePath: string | null = null;
      if (receipt.file) {
        imagePath = `${user.id}/${receipt.id}.jpg`;
        const upload = await supabase.storage.from('receipts').upload(imagePath, receipt.file, { contentType: 'image/jpeg', upsert: false });
        if (upload.error && !upload.error.message.toLowerCase().includes('exist')) continue;
      }
      const result = await supabase.from('expenses').insert({ id: receipt.id, user_id: user.id, household_id: household.id, payer_member_id: receipt.payerId, payer: receipt.payerName, merchant: receipt.merchant, amount: receipt.amount, category: receipt.category, notes: receipt.notes || null, receipt_date: receipt.receiptDate, currency: 'AUD', image_path: imagePath, image_original_name: receipt.file?.name ?? null, image_mime_type: receipt.file?.type ?? null, image_size_bytes: receipt.file?.size ?? null, ocr_status: 'manual', verified_at: receipt.createdAt });
      if (result.error && result.error.code !== '23505') { if (imagePath) await supabase.storage.from('receipts').remove([imagePath]); continue; }
      await removeOfflineReceipt(receipt.id); synced += 1;
    }
    if (synced) { setRefreshKey((value) => value + 1); notify(`${synced} offline receipt${synced === 1 ? '' : 's'} synced`); }
  }, [online, user, household, notify]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user ?? null); setAuthLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { setUser(session?.user ?? null); setAuthLoading(false); });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    window.localStorage.setItem('splitmate-theme', theme);
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    if (!sheetOpen && !confirmDelete) return;
    const scrollY = window.scrollY;
    const previous = { overflow: document.body.style.overflow, position: document.body.style.position, top: document.body.style.top, width: document.body.style.width };
    Object.assign(document.body.style, { overflow: 'hidden', position: 'fixed', top: `-${scrollY}px`, width: '100%' });
    return () => { Object.assign(document.body.style, previous); window.scrollTo(0, scrollY); };
  }, [sheetOpen, confirmDelete]);
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
    if (!user || !household) return;
    if (online) { void syncOfflineReceipts(); return; }
    void getOfflineReceipts().then((queued) => {
      const pending = queued.filter((receipt) => receipt.userId === user.id && receipt.householdId === household.id).map((receipt): Expense => ({ id: receipt.id, householdId: receipt.householdId, payerId: receipt.payerId, payerName: receipt.payerName, merchant: receipt.merchant, amount: receipt.amount, category: receipt.category, receiptDate: receipt.receiptDate, createdAt: receipt.createdAt, image: receipt.file ? URL.createObjectURL(receipt.file) : undefined, settled: false, ocrStatus: 'offline', notes: receipt.notes, syncStatus: 'pending' }));
      setExpenses((current) => [...pending, ...current.filter((expense) => !pending.some((item) => item.id === expense.id))]);
    });
  }, [online, user, household, syncOfflineReceipts]);
  useEffect(() => {
    if (!household || tab !== 'household') return;
    const inviteUrl = `${window.location.origin}/?join=${household.join_code}`;
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(inviteUrl, { width: 220, margin: 1, color: { dark: '#171a22', light: '#ffffff' } })).then(setQrCode);
  }, [household, tab]);
  useEffect(() => {
    if (!household) return;
    const channel = supabase.channel(`household:${household.id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'expenses', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).on('postgres_changes', { event: '*', schema: 'public', table: 'household_members', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).on('postgres_changes', { event: '*', schema: 'public', table: 'settlement_cycles', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).on('postgres_changes', { event: '*', schema: 'public', table: 'household_activity', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).on('postgres_changes', { event: '*', schema: 'public', table: 'household_categories', filter: `household_id=eq.${household.id}` }, () => setRefreshKey((value) => value + 1)).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [household]);

  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthKey = `${previousMonthDate.getFullYear()}-${String(previousMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const activeExpenses = useMemo(() => expenses.filter((expense) => !expense.settled), [expenses]);
  const monthExpenses = useMemo(() => expenses.filter((expense) => expense.receiptDate.startsWith(monthKey)), [expenses, monthKey]);
  const monthTotal = useMemo(() => monthExpenses.reduce((sum, expense) => sum + expense.amount, 0), [monthExpenses]);
  const previousMonthTotal = useMemo(() => expenses.filter((expense) => expense.receiptDate.startsWith(previousMonthKey)).reduce((sum, expense) => sum + expense.amount, 0), [expenses, previousMonthKey]);
  const total = useMemo(() => activeExpenses.reduce((sum, expense) => sum + expense.amount, 0), [activeExpenses]);
  const share = members.length ? total / members.length : 0;
  const transfers = useMemo(() => calculateTransfers(members, activeExpenses.map((expense) => ({ amount: expense.amount, payerId: expense.payerId }))), [members, activeExpenses]);
  const filteredExpenses = useMemo(() => expenses.filter((expense) => expense.settled === (receiptFilter === 'settled') && `${expense.merchant} ${expense.category} ${expense.payerName} ${expense.notes ?? ''}`.toLowerCase().includes(search.trim().toLowerCase())), [expenses, receiptFilter, search]);
  const allCategories = useMemo(() => [...defaultCategories, ...customCategories.map((category) => category.name).filter((name) => !defaultCategories.includes(name))], [customCategories]);
  const categoryTotals = useMemo(() => allCategories.map((category) => ({ category, total: monthExpenses.filter((expense) => expense.category === category).reduce((sum, expense) => sum + expense.amount, 0) })).filter((item) => item.total > 0).sort((a, b) => b.total - a.total), [monthExpenses, allCategories]);
  const merchantTotals = useMemo(() => Object.entries(monthExpenses.reduce<Record<string, number>>((totals, expense) => ({ ...totals, [expense.merchant]: (totals[expense.merchant] ?? 0) + expense.amount }), {})).sort((a, b) => b[1] - a[1]).slice(0, 4), [monthExpenses]);
  const memberTotals = useMemo(() => members.map((member) => ({ ...member, total: monthExpenses.filter((expense) => expense.payerId === member.id).reduce((sum, expense) => sum + expense.amount, 0) })), [members, monthExpenses]);
  const maxCategory = categoryTotals[0]?.total || 1;
  const isOwner = household?.created_by === user?.id;
  const greeting = now.getHours() < 12 ? 'Good morning.' : now.getHours() < 18 ? 'Good afternoon.' : 'Good evening.';
  const cycleLabel = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric' }).format(now);

  const openUpload = useCallback(() => uploadRef.current?.click(), []);
  const openCamera = useCallback(() => cameraRef.current?.click(), []);
  const closeEditor = (keepUpload = false) => {
    activeScan.current = '';
    if (!keepUpload && draft.scanJobId) {
      cancelledScan.current = draft.scanJobId;
      void supabase.from('receipt_scan_jobs').delete().eq('id', draft.scanJobId);
    }
    if (!keepUpload && !detail && draft.imagePath) {
      void supabase.storage.from('receipts').remove([draft.imagePath]);
    }
    if (draft.image.startsWith('blob:')) URL.revokeObjectURL(draft.image);
    setSheetOpen(false); setSheetExpanded(false); setDetail(null); setDraft(blankDraft()); setSwipedId(null);
  };
  const applyScanResult = useCallback((data: Record<string, unknown>, jobId: string) => {
    if (activeScan.current !== jobId) return;
    const scannedDate = typeof data.receipt_date === 'string' ? data.receipt_date : '';
    const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(scannedDate) ? scannedDate : localDate();
    const amount = typeof data.total_amount === 'number' || typeof data.total_amount === 'string' ? String(data.total_amount) : '';
    const merchant = typeof data.merchant === 'string' && data.merchant.trim() ? data.merchant : 'Receipt';
    const scannedCategory = typeof data.category === 'string' ? data.category : 'Other';
    const confidence = data.confidence as { merchant?: number; amount?: number; date?: number } | undefined;
    setDraft((current) => ({ ...current, merchant, amount, receiptDate, category: defaultCategories.includes(scannedCategory) ? scannedCategory : 'Other', ocrStatus: 'complete', ocrProcessedAt: new Date().toISOString(), lowConfidence: Boolean(confidence && Math.min(confidence.merchant ?? 0, confidence.amount ?? 0, confidence.date ?? 0) < .72), duplicate: expenses.some((expense) => expense.receiptDate === receiptDate && expense.merchant.toLowerCase() === merchant.toLowerCase() && Math.abs(expense.amount - Number(amount)) < .01) }));
  }, [expenses]);
  const scanFile = async (file: File, existingPath = '') => {
    if (!user || !household) return;
    setAnalyzing(true); const jobId = crypto.randomUUID(); activeScan.current = jobId;
    let imagePath = existingPath;
    try {
      if (!imagePath) {
        imagePath = `${user.id}/scans/${jobId}.jpg`;
        const upload = await supabase.storage.from('receipts').upload(imagePath, file, { contentType: 'image/jpeg', upsert: false });
        if (upload.error) throw upload.error;
      }
      const created = await supabase.from('receipt_scan_jobs').insert({ id: jobId, household_id: household.id, user_id: user.id, image_path: imagePath });
      if (created.error) throw created.error;
      setDraft((current) => ({ ...current, imagePath, scanJobId: jobId, ocrStatus: 'queued' }));
      const invoked = await supabase.functions.invoke('scan-receipt', { body: { jobId } });
      if (invoked.error) {
        const legacy = await supabase.functions.invoke('scan-receipt', { body: { imageBase64: await fileToBase64(file), mimeType: file.type } });
        if (legacy.error || legacy.data?.error) throw legacy.error ?? new Error(legacy.data.error);
        await supabase.from('receipt_scan_jobs').delete().eq('id', jobId);
        setDraft((current) => ({ ...current, scanJobId: '' })); applyScanResult(legacy.data as Record<string, unknown>, jobId); return;
      }
      let job: { status: string; result: Record<string, unknown> | null; error_message: string | null } | null = null;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const response = await supabase.from('receipt_scan_jobs').select('status,result,error_message').eq('id', jobId).single();
        if (response.error) throw response.error;
        job = response.data;
        if (job.status === 'complete' || job.status === 'failed') break;
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      if (!job || job.status === 'failed') throw new Error(job?.error_message || 'Scanning failed — enter the details manually');
      if (job.status !== 'complete' || !job.result) throw new Error('Scanning is still running. You can return to this receipt shortly.');
      if (activeScan.current !== jobId) return;
      applyScanResult(job.result, jobId);
    } catch (scanError) {
      if (activeScan.current !== jobId) return;
      if (!existingPath && imagePath && !draft.imagePath) setDraft((current) => ({ ...current, imagePath }));
      setDraft((current) => ({ ...current, ocrStatus: 'failed', ocrProcessedAt: new Date().toISOString() }));
      notify(scanError instanceof Error ? scanError.message : 'Scanning failed — enter the details manually');
    } finally { if (activeScan.current === jobId) setAnalyzing(false); }
  };
  const handleFile = async (original?: File) => {
    if (!original) return;
    try {
      const file = await prepareReceiptImage(original);
      const image = URL.createObjectURL(file);
      setDraft({ ...blankDraft(), merchant: original.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '), receiptDate: localDate(), payerId: self?.id ?? '', image, file, ocrStatus: online ? 'queued' : 'offline' });
      setSheetExpanded(false); setSheetOpen(true); setDetail(null);
      if (online) await scanFile(file); else notify('Offline — enter the total and this receipt will sync later');
    } catch (imageError) { notify(imageError instanceof Error ? imageError.message : 'Could not open that image'); }
    finally { if (uploadRef.current) uploadRef.current.value = ''; if (cameraRef.current) cameraRef.current.value = ''; }
  };
  const openDetail = (expense: Expense) => { if (expense.syncStatus) { notify('This receipt will be editable after it syncs'); return; } setDetail(expense); setDraft({ ...blankDraft(), merchant: expense.merchant, amount: String(expense.amount), category: expense.category, receiptDate: expense.receiptDate, payerId: expense.payerId, image: expense.image ?? '', imagePath: expense.imagePath ?? '', notes: expense.notes ?? '', ocrStatus: expense.ocrStatus }); setSheetExpanded(false); setSheetOpen(true); };
  const saveExpense = async () => {
    const amount = Number(draft.amount);
    if (!user || !household || !draft.payerId || !draft.merchant.trim() || !(amount > 0)) return;
    const payer = members.find((member) => member.id === draft.payerId); const expenseId = detail?.id ?? crypto.randomUUID();
    if (!online && !detail) {
      const queued: OfflineReceipt = { id: expenseId, userId: user.id, householdId: household.id, payerId: draft.payerId, payerName: payer?.name ?? 'Member', merchant: draft.merchant.trim(), amount, category: draft.category, receiptDate: draft.receiptDate || localDate(), notes: draft.notes.trim(), file: draft.file, createdAt: new Date().toISOString() };
      await saveOfflineReceipt(queued);
      setExpenses((current) => [{ id: queued.id, householdId: queued.householdId, payerId: queued.payerId, payerName: queued.payerName, merchant: queued.merchant, amount: queued.amount, category: queued.category, receiptDate: queued.receiptDate, createdAt: queued.createdAt, image: queued.file ? URL.createObjectURL(queued.file) : undefined, settled: false, ocrStatus: 'offline', notes: queued.notes, syncStatus: 'pending' }, ...current]);
      closeEditor(true); notify('Saved offline · will sync automatically'); return;
    }
    setSaving(true); let imagePath: string | null = draft.imagePath || detail?.imagePath || null;
    try {
      if (!detail && draft.file && !imagePath) { imagePath = `${user.id}/${expenseId}.jpg`; const upload = await supabase.storage.from('receipts').upload(imagePath, draft.file, { contentType: 'image/jpeg', upsert: false }); if (upload.error) throw upload.error; }
      const payload = { household_id: household.id, payer_member_id: draft.payerId, payer: payer?.name ?? 'Member', merchant: draft.merchant.trim(), amount, category: draft.category, notes: draft.notes.trim() || null, receipt_date: draft.receiptDate || null, verified_at: new Date().toISOString(), ocr_status: draft.ocrStatus === 'failed' ? 'manual' : draft.ocrStatus, ocr_processed_at: draft.ocrProcessedAt, ocr_model: draft.ocrStatus === 'complete' ? 'gemini-3.7-flash' : detail?.ocrModel ?? null };
      const result = detail ? await supabase.from('expenses').update(payload).eq('id', detail.id) : await supabase.from('expenses').insert({ ...payload, id: expenseId, user_id: user.id, currency: 'AUD', image_path: imagePath, image_original_name: draft.file?.name ?? null, image_mime_type: draft.file?.type ?? null, image_size_bytes: draft.file?.size ?? null });
      if (result.error) throw result.error;
      if (draft.scanJobId) await supabase.from('receipt_scan_jobs').delete().eq('id', draft.scanJobId);
      closeEditor(true); setRefreshKey((value) => value + 1); notify(detail ? 'Receipt updated' : 'Receipt added');
    } catch (saveError) { if (!detail && imagePath) await supabase.storage.from('receipts').remove([imagePath]); if (draft.scanJobId) await supabase.from('receipt_scan_jobs').delete().eq('id', draft.scanJobId); notify(saveError instanceof Error ? saveError.message : 'Could not save receipt'); }
    finally { setSaving(false); }
  };
  const rescanDetail = async () => {
    if (draft.file) { await scanFile(draft.file, detail?.imagePath); return; }
    if (!detail?.imagePath) return;
    const result = await supabase.storage.from('receipts').download(detail.imagePath);
    if (result.error) { notify(result.error.message); return; }
    await scanFile(new File([result.data], 'receipt.jpg', { type: result.data.type || 'image/jpeg' }), detail.imagePath);
  };
  const purgeExpense = async (expense: Expense) => { const storageResult = expense.imagePath ? await supabase.storage.from('receipts').remove([expense.imagePath]) : { error: null }; if (!storageResult.error) await supabase.from('expenses').delete().eq('id', expense.id); if (pendingDelete.current?.expense.id === expense.id) pendingDelete.current = null; };
  const deleteExpense = async (expense: Expense) => {
    if (expense.syncStatus === 'pending') { await removeOfflineReceipt(expense.id); setExpenses((current) => current.filter((item) => item.id !== expense.id)); notify('Offline receipt removed'); return; }
    if (pendingDelete.current) { window.clearTimeout(pendingDelete.current.timer); await purgeExpense(pendingDelete.current.expense); }
    const result = await supabase.from('expenses').update({ deleted_at: new Date().toISOString() }).eq('id', expense.id);
    if (result.error) { notify(result.error.message); return; }
    setExpenses((current) => current.filter((item) => item.id !== expense.id)); closeEditor();
    const undo = async () => { if (pendingDelete.current?.expense.id !== expense.id) return; window.clearTimeout(pendingDelete.current.timer); pendingDelete.current = null; const restored = await supabase.from('expenses').update({ deleted_at: null }).eq('id', expense.id); if (restored.error) notify(restored.error.message); else { setRefreshKey((value) => value + 1); notify('Receipt restored'); } };
    const timer = window.setTimeout(() => void purgeExpense(expense), 5200); pendingDelete.current = { expense, timer };
    notify('Receipt deleted', { label: 'Undo', run: () => void undo() }, 5000);
  };
  const requestDelete = (expense: Expense) => { setSwipedId(null); setConfirmDelete(expense); };
  const settleCycle = async () => { if (!household || !activeExpenses.length) return; setSaving(true); const result = await supabase.rpc('settle_household', { target_household: household.id, transfer_summary: transfers }); setSaving(false); if (result.error) notify(result.error.message); else { setRefreshKey((value) => value + 1); notify('Cycle settled'); } };
  const shareSettlement = async () => { const text = `${household?.name ?? 'Household'} settlement\n${transfers.length ? transfers.map((transfer) => `${transfer.from} pays ${transfer.to} ${money.format(transfer.amount)}`).join('\n') : 'Everyone is even.'}`; if (navigator.share) await navigator.share({ title: 'SplitMate settlement', text }); else { await navigator.clipboard.writeText(text); notify('Settlement copied'); } };
  const registerPasskey = async () => {
    setPasskeyBusy(true);
    try {
      const result = await supabase.auth.registerPasskey();
      if (result.error) notify(result.error.message); else notify('Face ID or passkey is ready');
    } catch (passkeyError) { notify(passkeyError instanceof Error ? passkeyError.message : 'Passkey setup was cancelled'); }
    finally { setPasskeyBusy(false); }
  };
  const inviteUrl = household ? `${window.location.origin}/?join=${household.join_code}` : '';
  const shareInvite = async () => {
    const text = `Join ${household?.name ?? 'my household'} on SplitMate: ${inviteUrl}`;
    if (navigator.share) await navigator.share({ title: 'Join my SplitMate household', text, url: inviteUrl });
    else { await navigator.clipboard.writeText(inviteUrl); notify('Invite link copied'); }
  };
  const saveProfileName = async () => { if (!self || profileName.trim() === self.name) return; const result = await supabase.rpc('rename_self', { target_member: self.id, new_name: profileName }); if (result.error) notify(result.error.message); else { setRefreshKey((value) => value + 1); void loadMembership(); notify('Name updated'); } };
  const saveHouseholdName = async () => { if (!user || !household || householdName.trim() === household.name) return; const result = await supabase.rpc('rename_household', { target_household: household.id, new_name: householdName }); if (result.error) notify(result.error.message); else { window.localStorage.removeItem(`splitmate-membership:${user.id}`); await loadMembership(); notify('Household renamed'); } };
  const addCategory = async () => { if (!user || !household || !newCategory.trim()) return; const result = await supabase.from('household_categories').insert({ household_id: household.id, name: newCategory.trim(), created_by: user.id }); if (result.error) notify(result.error.message); else { setNewCategory(''); setRefreshKey((value) => value + 1); notify('Category added'); } };
  const regenerateInvite = async () => { if (!user || !household || !window.confirm('Replace the current invite code? The old link will stop working.')) return; const result = await supabase.rpc('regenerate_household_invite', { target_household: household.id }); if (result.error) notify(result.error.message); else { window.localStorage.removeItem(`splitmate-membership:${user.id}`); await loadMembership(); notify('New invite created'); } };
  const removeMember = async (member: Member) => { if (!window.confirm(`Remove ${member.name} from this household?`)) return; const result = await supabase.rpc('remove_household_member', { target_member: member.id }); if (result.error) notify(result.error.message); else { setRefreshKey((value) => value + 1); notify(`${member.name} removed`); } };
  const leaveHousehold = async () => { if (!user || !household || !window.confirm(isOwner ? 'Delete this household? This cannot be undone.' : 'Leave this household?')) return; const result = await supabase.rpc('leave_household', { target_household: household.id }); if (result.error) notify(result.error.message); else { window.localStorage.removeItem(`splitmate-membership:${user.id}`); setHousehold(null); setSelf(null); await loadMembership(); } };
  const receiptRow = (expense: Expense) => {
    const payer = members.find((member) => member.id === expense.payerId) ?? self; const isOpen = !expense.settled && swipedId === expense.id;
    return <div className={`swipe-shell ${expense.settled ? 'swipe-disabled' : ''}`} key={expense.id}>{!expense.settled && <button className="swipe-delete" onClick={() => requestDelete(expense)} aria-label={`Delete ${expense.merchant}`}><Trash2 size={19} /><span>Delete</span></button>}<button className={`receipt-row ${isOpen ? 'receipt-row-swiped' : ''}`} onTouchStart={(event) => { touchStart.current = event.touches[0].clientX; }} onTouchEnd={(event) => { if (expense.settled) return; const distance = event.changedTouches[0].clientX - touchStart.current; if (distance < -45) setSwipedId(expense.id); if (distance > 35) setSwipedId(null); }} onClick={() => { if (isOpen) setSwipedId(null); else openDetail(expense); }}><div className="receipt-thumb">{expense.image ? <img src={expense.image} alt="" /> : <ReceiptText size={21} />}</div><div className="receipt-main"><h3>{expense.merchant}</h3><p>{expense.syncStatus ? 'Waiting to sync' : `${expense.category} · ${new Date(`${expense.receiptDate}T00:00:00`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`}</p></div><div className="receipt-amount"><strong>{money.format(expense.amount)}</strong><span>{payer && <i style={{ background: payer.color }} />}{expense.payerName}</span></div><ChevronRight size={17} className="row-chevron" /></button></div>;
  };

  useEffect(() => {
    if (!online || !user || !household || !self) return;
    let stopped = false;
    void (async () => {
      const latest = await supabase.from('receipt_scan_jobs').select('id,image_path,status,result,error_message').eq('user_id', user.id).eq('household_id', household.id).in('status', ['queued', 'processing', 'complete']).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (stopped || !latest.data || latest.data.id === cancelledScan.current) return;
      const job = latest.data; activeScan.current = job.id;
      const signed = await supabase.storage.from('receipts').createSignedUrl(job.image_path, 3600);
      setDetail(null); setDraft({ ...blankDraft(), merchant: 'Receipt', receiptDate: localDate(), payerId: self.id, image: signed.data?.signedUrl ?? '', imagePath: job.image_path, scanJobId: job.id, ocrStatus: job.status }); setSheetOpen(true);
      if (job.status === 'complete' && job.result) { applyScanResult(job.result as Record<string, unknown>, job.id); return; }
      setAnalyzing(true);
      if (job.status === 'queued') await supabase.functions.invoke('scan-receipt', { body: { jobId: job.id } });
      for (let attempt = 0; attempt < 32 && !stopped; attempt += 1) {
        const response = await supabase.from('receipt_scan_jobs').select('status,result,error_message').eq('id', job.id).single();
        if (response.data?.status === 'complete' && response.data.result) { applyScanResult(response.data.result as Record<string, unknown>, job.id); break; }
        if (response.data?.status === 'failed') { notify(response.data.error_message || 'Receipt scan failed'); break; }
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      if (!stopped) setAnalyzing(false);
    })();
    return () => { stopped = true; };
  }, [online, user, household, self, applyScanResult, notify]);

  useEffect(() => {
    const context = document.modelContext; if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(context.registerTool({ name: 'start_receipt_creation', title: 'Add a household receipt', description: 'Open Photos to choose and scan a household bill.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false }, execute: () => { openUpload(); return { status: 'photo_picker_opened' }; } }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [openUpload]);

  if (authLoading) return <main className="loading-screen"><img className="brand-logo loading-logo" src="/app-icon.svg" alt="SplitMate" /><span className="loader" /><p>Opening SplitMate…</p></main>;
  if (!user) return <AuthScreen />;
  if (loading) return <main className="loading-screen"><img className="brand-logo loading-logo" src="/app-icon.svg" alt="SplitMate" /><span className="loader" /><p>Loading your household…</p></main>;
  if (!household || !self) return <HouseholdSetup user={user} onReady={() => void loadMembership()} />;

  return <main className="app-shell">
    <input ref={uploadRef} className="hidden" type="file" accept="image/*" onChange={(event) => void handleFile(event.target.files?.[0])} />
    <input ref={cameraRef} className="hidden" type="file" accept="image/*" capture="environment" onChange={(event) => void handleFile(event.target.files?.[0])} />
    {!online && <div className="network-banner"><WifiOff size={15} /> Offline · bills save on this iPhone</div>}
    <div className="app-frame"><header className="topbar"><div><p>{household.name}</p><h1>{tab === 'home' ? greeting : tab === 'receipts' ? 'Receipts' : tab === 'insights' ? 'Insights' : tab === 'household' ? 'Household' : 'Settings'}</h1></div>{(tab === 'home' || tab === 'receipts') && <div className="top-actions"><button onClick={openCamera} className="circle-button secondary" aria-label="Scan with camera"><Camera size={20} /></button><button onClick={openUpload} className="circle-button" aria-label="Choose bill from Photos"><ImagePlus size={21} /></button></div>}</header>{error && <div className="error-banner"><span>{error}</span><button onClick={() => setRefreshKey((value) => value + 1)}>Retry</button></div>}
      {tab === 'home' && <div className="content-grid"><section className="stack"><div className="balance-card"><p>{cycleLabel}</p><strong>{money.format(total)}</strong><span>{money.format(share)} each · {activeExpenses.length} receipts</span><div className="member-stack">{members.map((member) => <Avatar key={member.id} member={member} small />)}</div></div><div className="source-actions"><button className="capture-button" onClick={openUpload}><ImagePlus size={22} /><span><strong>Choose bill from Photos</strong><small>{online ? 'Scanning image fills in the details' : 'Save now and sync when online'}</small></span><ChevronRight size={20} /></button></div><section><div className="section-heading"><h2>Recent receipts</h2><button onClick={() => setTab('receipts')}>See all</button></div><div className="list-card">{activeExpenses.length ? activeExpenses.slice(0, 3).map(receiptRow) : <div className="empty-state"><ReceiptText /><strong>No bills this cycle</strong><p>Choose one from Photos to get started.</p></div>}</div></section></section><section className="stack"><div className="section-heading"><h2>Settle up</h2><span>{members.length} people</span></div><div className="settlement-card">{!activeExpenses.length ? <div className="empty-state compact"><Check /><strong>Everything is settled</strong></div> : transfers.length ? transfers.map((transfer) => <div className="transfer-row" key={`${transfer.fromId}-${transfer.toId}`}><span><strong>{transfer.from}</strong> pays {transfer.to}</span><b>{money.format(transfer.amount)}</b></div>) : <div className="empty-state compact"><Check /><strong>Everyone is even</strong></div>}<div className="settlement-actions"><button disabled={!activeExpenses.length || saving} onClick={() => void shareSettlement()}><Share2 size={18} /> Share</button><button disabled={!activeExpenses.length || saving} onClick={() => void settleCycle()}><Check size={18} /> {saving ? 'Saving…' : 'Mark settled'}</button></div></div></section></div>}
      {tab === 'receipts' && <section className="single-column"><label className="search-field"><Search size={18} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search merchant, category or person" /></label><div className="segmented"><button className={receiptFilter === 'active' ? 'selected' : ''} onClick={() => setReceiptFilter('active')}>Current</button><button className={receiptFilter === 'settled' ? 'selected' : ''} onClick={() => setReceiptFilter('settled')}>History</button></div><div className="list-card">{filteredExpenses.length ? filteredExpenses.map(receiptRow) : <div className="empty-state"><Search /><strong>No matching receipts</strong><p>Try a different search.</p></div>}</div></section>}
      {tab === 'insights' && <section className="single-column insights-page"><div className="insight-summary"><div><span>This month</span><strong>{money.format(monthTotal)}</strong></div><div><span>Your share</span><strong>{money.format(members.length ? monthTotal / members.length : 0)}</strong></div><div><span>vs last month</span><strong>{previousMonthTotal ? `${Math.round((monthTotal - previousMonthTotal) / previousMonthTotal * 100)}%` : '—'}</strong></div></div><div className="insight-card"><div className="section-heading"><h2>By category</h2><span>{cycleLabel}</span></div>{categoryTotals.length ? categoryTotals.map((item) => <div className="bar-row" key={item.category}><div><span>{item.category}</span><b>{money.format(item.total)}</b></div><i><span style={{ width: `${Math.max(6, item.total / maxCategory * 100)}%` }} /></i></div>) : <div className="empty-state compact"><ChartNoAxesColumnIncreasing /><strong>No spending yet</strong></div>}</div><div className="insight-card"><div className="section-heading"><h2>Paid by</h2></div>{memberTotals.map((member) => <div className="paid-row" key={member.id}><Avatar member={member} small /><span>{member.name}</span><b>{money.format(member.total)}</b></div>)}</div>{merchantTotals.length > 0 && <div className="insight-card"><div className="section-heading"><h2>Top merchants</h2></div>{merchantTotals.map(([merchant, amount]) => <div className="merchant-row" key={merchant}><span>{merchant}</span><b>{money.format(amount)}</b></div>)}</div>}{cycles.length > 0 && <div className="insight-card"><div className="section-heading"><h2>Settlement history</h2></div>{cycles.slice(0, 4).map((cycle) => <div className="history-row" key={cycle.id}><div><strong>{new Date(cycle.settled_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</strong><span>{cycle.member_count} people</span></div><b>{money.format(cycle.total_amount)}</b></div>)}</div>}</section>}
      {tab === 'household' && <section className="single-column household-page"><div className="invite-card invite-expanded"><div><p>Invite to household</p><strong>{household.join_code}</strong><span>Share a secure link or let someone scan the code.</span><div className="invite-actions"><button onClick={() => void shareInvite()}><Link2 size={17} /> Share invite</button>{isOwner && <button onClick={() => void regenerateInvite()}><RefreshCw size={16} /> Replace</button>}</div></div>{qrCode && <img src={qrCode} alt="Household invitation QR code" />}</div><div className="section-heading"><h2>Members</h2><span>Every bill is split equally</span></div><div className="list-card">{members.map((member) => <div className="member-row managed" key={member.id}><Avatar member={member} /><div><strong>{member.name}</strong><span>{member.user_id === self.user_id ? 'You' : 'Household member'}</span></div>{isOwner && member.user_id !== user.id && <button onClick={() => void removeMember(member)} aria-label={`Remove ${member.name}`}><UserMinus size={18} /></button>}</div>)}</div>{activities.length > 0 && <div><div className="section-heading"><h2>Activity</h2><span>Latest changes</span></div><div className="list-card activity-list">{activities.slice(0, 12).map((activity) => <div className="activity-row" key={activity.id}><span className={`activity-dot ${activity.action}`} /><div><strong>{activity.actor_name || 'SplitMate'} {activity.summary}</strong><small>{new Date(activity.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</small></div></div>)}</div></div>}</section>}
      {tab === 'settings' && <section className="single-column settings-page"><div className="settings-profile"><Avatar member={self} /><div><strong>{self.name}</strong><span>{user.email}</span></div></div><div><p className="settings-label">Profile</p><div className="settings-group"><label className="inline-setting"><span className="settings-icon"><Pencil size={18} /></span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} maxLength={50} aria-label="Display name" /><button disabled={!profileName.trim() || profileName.trim() === self.name} onClick={() => void saveProfileName()}>Save</button></label>{isOwner && <label className="inline-setting"><span className="settings-icon"><Home size={18} /></span><input value={householdName} onChange={(event) => setHouseholdName(event.target.value)} maxLength={60} aria-label="Household name" /><button disabled={!householdName.trim() || householdName.trim() === household.name} onClick={() => void saveHouseholdName()}>Save</button></label>}</div></div><div><p className="settings-label">Categories</p><div className="settings-group"><label className="inline-setting"><span className="settings-icon"><Plus size={19} /></span><input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} maxLength={30} placeholder="New category" aria-label="New category" /><button disabled={!newCategory.trim()} onClick={() => void addCategory()}>Add</button></label>{customCategories.map((category) => <div className="settings-row compact-setting" key={category.id}><span>{category.name}</span><button aria-label={`Delete ${category.name}`} onClick={async () => { const result = await supabase.from('household_categories').delete().eq('id', category.id); if (result.error) notify(result.error.message); else setRefreshKey((value) => value + 1); }}><X size={16} /></button></div>)}</div></div><div><p className="settings-label">Appearance</p><div className="settings-group"><div className="settings-row"><span className="settings-icon"><Palette size={19} /></span><div><strong>Appearance</strong><small>Choose how SplitMate looks.</small></div><div className="theme-picker" aria-label="Appearance">{(['system', 'light', 'dark'] as const).map((value) => <button key={value} className={theme === value ? 'selected' : ''} onClick={() => setTheme(value)}>{value[0].toUpperCase() + value.slice(1)}</button>)}</div></div></div></div><div><p className="settings-label">Security</p><div className="settings-group">{typeof PublicKeyCredential !== 'undefined' && <button className="settings-row settings-button" disabled={passkeyBusy} onClick={() => void registerPasskey()}><span className="settings-icon"><Fingerprint size={20} /></span><div><strong>{passkeyBusy ? 'Opening security check…' : 'Face ID or passkey'}</strong><small>Sign in without entering your password.</small></div><ChevronRight size={18} /></button>}<div className="settings-row"><span className="settings-icon"><ShieldCheck size={19} /></span><div><strong>Private household</strong><small>Only members can see receipts and balances.</small></div></div></div></div><div><p className="settings-label">Account</p><div className="settings-group"><button className="settings-row settings-button danger-row" onClick={() => void leaveHousehold()}><span className="settings-icon"><UserMinus size={19} /></span><div><strong>{isOwner ? 'Delete household' : 'Leave household'}</strong><small>{isOwner ? 'Only possible when no other members remain.' : 'Remove your account from this household.'}</small></div><ChevronRight size={18} /></button><button className="settings-row settings-button danger-row" onClick={() => void supabase.auth.signOut()}><span className="settings-icon"><LogOut size={19} /></span><div><strong>Sign out</strong><small>Keep this device’s data private.</small></div><ChevronRight size={18} /></button></div></div><p className="settings-footer">SplitMate · Household bills, sorted.</p></section>}
    </div>
    <nav className="bottom-nav" aria-label="Primary navigation"><button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}><Home size={21} /><span>Home</span></button><button className={tab === 'receipts' ? 'active' : ''} onClick={() => setTab('receipts')}><ReceiptText size={21} /><span>Receipts</span></button><button className={tab === 'insights' ? 'active' : ''} onClick={() => setTab('insights')}><ChartNoAxesColumnIncreasing size={21} /><span>Insights</span></button><button className={tab === 'household' ? 'active' : ''} onClick={() => setTab('household')}><Users size={21} /><span>Household</span></button><button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings2 size={21} /><span>Settings</span></button></nav>
    {sheetOpen && <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) closeEditor(); }}><dialog open className={`receipt-sheet ${sheetExpanded ? 'sheet-expanded' : ''}`} aria-labelledby="receipt-title"><button className="sheet-handle" aria-label={sheetExpanded ? 'Make receipt panel smaller' : 'Expand receipt panel'} onClick={() => setSheetExpanded((value) => !value)} onTouchStart={(event) => { sheetTouchStart.current = event.touches[0].clientY; }} onTouchEnd={(event) => { const distance = event.changedTouches[0].clientY - sheetTouchStart.current; if (distance < -24) setSheetExpanded(true); if (distance > 24) setSheetExpanded(false); }}><span className="grabber" /></button><header><button className="sheet-close" onClick={() => closeEditor()} disabled={saving}><X /></button><div><p>{detail ? 'Receipt details' : analyzing ? 'Scanning image' : 'Review details'}</p><h2 id="receipt-title">{detail?.settled ? 'Settled receipt' : detail ? 'Edit receipt' : 'New receipt'}</h2></div>{detail && !detail.settled ? <button className="sheet-delete" onClick={() => requestDelete(detail)}><Trash2 size={18} /> Delete</button> : <span />}</header>{draft.image && <img className="receipt-preview" src={draft.image} alt="Selected receipt" />}{analyzing && <div className="scan-status"><span className="loader small" />Scanning image securely…</div>}{!online && !detail && <div className="scan-status offline-status"><WifiOff size={16} />Saved on this iPhone until you reconnect</div>}{draft.lowConfidence && <div className="warning-banner">Some details may be unclear. Please check the highlighted result.</div>}{draft.duplicate && <div className="warning-banner">This looks like a receipt already saved.</div>}<div className="editor-fields"><label className="field-label">Merchant<input disabled={detail?.settled} className="field-input" value={draft.merchant} onChange={(event) => setDraft({ ...draft, merchant: event.target.value })} /></label><div className="two-columns"><label className="field-label">Total (AUD)<input disabled={detail?.settled} className="field-input" inputMode="decimal" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></label><label className="field-label">Category<select disabled={detail?.settled} className="field-input" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>{allCategories.map((category) => <option key={category}>{category}</option>)}</select></label></div><div className="two-columns"><label className="field-label">Receipt date<input disabled={detail?.settled} className="field-input" type="date" value={draft.receiptDate} onChange={(event) => setDraft({ ...draft, receiptDate: event.target.value })} /></label><label className="field-label">Paid by<select disabled={detail?.settled} className="field-input" value={draft.payerId} onChange={(event) => setDraft({ ...draft, payerId: event.target.value })}>{members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label></div><label className="field-label">Note <span className="optional">Optional</span><textarea disabled={detail?.settled} className="field-input field-textarea" maxLength={300} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="What was this bill for?" /></label><p className="privacy-note">Scanning sends this image securely to the receipt-reading service. All household members share the expense equally.</p>{detail?.settled ? <div className="settled-note"><Check size={17} /> Included in a completed settlement</div> : <>{online && (draft.file || detail?.imagePath) && <button className="rescan-button" disabled={analyzing || saving} onClick={() => void rescanDetail()}><RefreshCw size={17} /> Scan image again</button>}<button className="primary-button" disabled={analyzing || saving || !draft.payerId || !draft.merchant.trim() || !(Number(draft.amount) > 0)} onClick={() => void saveExpense()}>{saving ? 'Saving…' : !online && !detail ? 'Save offline' : detail ? 'Save changes' : 'Add receipt'} {!saving && <ArrowRight size={18} />}</button></>}</div></dialog></div>}
    {confirmDelete && <div className="confirm-backdrop" role="presentation"><div className="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="delete-title"><span className="confirm-icon"><Trash2 size={24} /></span><h2 id="delete-title">Delete this receipt?</h2><p>{confirmDelete.merchant} will be removed for everyone in the household. You can undo immediately after deleting.</p><div><button onClick={() => setConfirmDelete(null)}>Cancel</button><button className="destructive" onClick={() => { const expense = confirmDelete; setConfirmDelete(null); void deleteExpense(expense); }}>Delete Receipt</button></div></div></div>}
    {toast && <div className="toast"><Check size={16} /><span>{toast.message}</span>{toast.action && <button onClick={toast.action.run}>{toast.action.label}</button>}</div>}
  </main>;
}
