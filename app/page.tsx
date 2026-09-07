'use client';

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Image from 'next/image';
import { WifiOff } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { prepareReceiptImage } from '@/lib/receipt-image';
import { calculateTransfers } from '@/lib/settlements';
import {
  getOfflineReceipts,
  removeOfflineReceipt,
  saveOfflineReceipt,
  type OfflineReceipt,
} from '@/lib/offline-receipts';
import {
  blankDraft,
  defaultCategories,
  localDate,
  money,
  type Activity,
  type AppTab,
  type Cycle,
  type Draft,
  type Expense,
  type Household,
  type HouseholdCategory,
  type Member,
  type ReceiptFlag,
  type ToastState,
} from '@/lib/splitmate-models';
import { AuthScreen } from '@/components/splitmate/auth-screen';
import { HouseholdSetup } from '@/components/splitmate/household-setup';
import { HomeView } from '@/components/splitmate/home-view';
import { ReceiptsView } from '@/components/splitmate/receipts-view';
import { HouseholdView } from '@/components/splitmate/household-view';
import { SettingsView } from '@/components/splitmate/settings-view';
import {
  AppHeader,
  BottomNavigation,
} from '@/components/splitmate/app-navigation';
import { ReceiptRow } from '@/components/splitmate/receipt-row';
import {
  AppToast,
  DeleteConfirmation,
  SettlementReview,
} from '@/components/splitmate/app-overlays';
import { ReceiptEditor } from '@/components/splitmate/receipt-editor';

declare global {
  interface Document {
    modelContext?: {
      registerTool: (
        tool: Record<string, unknown>,
        options?: { signal?: AbortSignal },
      ) => void | Promise<void>;
    };
  }
}

const InsightsView = lazy(() => import('./insights-view'));

export default function HomePage() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [household, setHousehold] = useState<Household | null>(null);
  const [self, setSelf] = useState<Member | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [customCategories, setCustomCategories] = useState<HouseholdCategory[]>(
    [],
  );
  const [receiptFlags, setReceiptFlags] = useState<ReceiptFlag[]>([]);
  const [tab, setTab] = useState<AppTab>('home');
  const [theme, setTheme] = useState<'system' | 'light' | 'dark'>(() =>
    typeof window === 'undefined'
      ? 'system'
      : ((window.localStorage.getItem('splitmate-theme') as
          | 'system'
          | 'light'
          | 'dark'
          | null) ?? 'system'),
  );
  const [receiptFilter, setReceiptFilter] = useState<'active' | 'settled'>(
    'active',
  );
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(true);
  const [error, setError] = useState('');
  const [online, setOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Expense | null>(null);
  const [settlementReview, setSettlementReview] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [detail, setDetail] = useState<Expense | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyConfigured, setPasskeyConfigured] = useState(false);
  const [qrCode, setQrCode] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [profileName, setProfileName] = useState('');
  const [householdName, setHouseholdName] = useState('');
  const [flagReason, setFlagReason] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | null>(null);
  const pendingDelete = useRef<{ expense: Expense; timer: number } | null>(
    null,
  );
  const activeScan = useRef('');
  const cancelledScan = useRef('');
  const currentHouseholdId = useRef<string | null>(null);

  const notify = useCallback(
    (message: string, action?: ToastState['action'], duration = 2800) => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast({ message, action });
      toastTimer.current = window.setTimeout(() => setToast(null), duration);
    },
    [],
  );

  const loadMembership = useCallback(async () => {
    if (!user) return;
    const cached = window.localStorage.getItem(
      `splitmate-membership:${user.id}`,
    );
    if (cached) {
      const parsed = JSON.parse(cached) as {
        self: Member;
        household: Household;
      };
      currentHouseholdId.current = parsed.household.id;
      setSelf(parsed.self);
      setHousehold(parsed.household);
      setProfileName(parsed.self.name);
      setHouseholdName(parsed.household.name);
      setLoading(false);
      if (!navigator.onLine) return;
    } else setLoading(true);
    setError('');
    const memberResult = await supabase
      .from('household_members')
      .select('*,households(id,name,join_code,created_by)')
      .eq('user_id', user.id)
      .is('left_at', null)
      .limit(1)
      .maybeSingle();
    if (memberResult.error) {
      if (cached && !navigator.onLine) {
        const parsed = JSON.parse(cached) as {
          self: Member;
          household: Household;
        };
        setSelf(parsed.self);
        setHousehold(parsed.household);
      } else setError(memberResult.error.message);
      setLoading(false);
      return;
    }
    if (!memberResult.data) {
      window.localStorage.removeItem(`splitmate-membership:${user.id}`);
      currentHouseholdId.current = null;
      setSelf(null);
      setHousehold(null);
      setLoading(false);
      return;
    }
    const rawMember = memberResult.data as Member & {
      households: Household | Household[];
    };
    const loadedHousehold = Array.isArray(rawMember.households)
      ? rawMember.households[0]
      : rawMember.households;
    const { households: _households, ...loadedMember } = rawMember;
    if (!loadedHousehold) {
      setError('Household could not be loaded.');
      setLoading(false);
      return;
    }
    if (currentHouseholdId.current !== loadedHousehold.id) setDataLoading(true);
    currentHouseholdId.current = loadedHousehold.id;
    setSelf(loadedMember);
    setHousehold(loadedHousehold);
    setProfileName(loadedMember.name);
    setHouseholdName(loadedHousehold.name);
    window.localStorage.setItem(
      `splitmate-membership:${user.id}`,
      JSON.stringify({ self: loadedMember, household: loadedHousehold }),
    );
    setLoading(false);
  }, [user]);

  const loadData = useCallback(async () => {
    if (!household) return;
    setError('');
    const cached = window.localStorage.getItem(
      `splitmate-data:${household.id}`,
    );
    if (cached) {
      const parsed = JSON.parse(cached) as {
        members: Member[];
        expenses: Expense[];
        cycles: Cycle[];
      };
      setMembers(parsed.members);
      setExpenses(parsed.expenses);
      setCycles(parsed.cycles);
      setDataLoading(false);
      if (!online) return;
    }
    if (!online) {
      setError('Connect once to load this household on this iPhone.');
      setDataLoading(false);
      return;
    }
    const [
      memberResult,
      expenseResult,
      cycleResult,
      activityResult,
      categoryResult,
      flagResult,
    ] = await Promise.all([
      supabase
        .from('household_members')
        .select('*')
        .eq('household_id', household.id)
        .is('left_at', null)
        .order('joined_at'),
      supabase
        .from('expenses')
        .select('*')
        .eq('household_id', household.id)
        .is('deleted_at', null)
        .order('receipt_date', { ascending: false })
        .limit(200),
      supabase
        .from('settlement_cycles')
        .select('*')
        .eq('household_id', household.id)
        .order('settled_at', { ascending: false })
        .limit(12),
      supabase
        .from('household_activity')
        .select('id,actor_name,summary,action,created_at')
        .eq('household_id', household.id)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('household_categories')
        .select('id,name')
        .eq('household_id', household.id)
        .order('name'),
      supabase
        .from('receipt_flags')
        .select('id,expense_id,reported_by,reason,status,created_at')
        .eq('household_id', household.id)
        .eq('status', 'open')
        .order('created_at', { ascending: false }),
    ]);
    const firstError =
      memberResult.error ??
      expenseResult.error ??
      cycleResult.error ??
      activityResult.error ??
      categoryResult.error ??
      flagResult.error;
    if (firstError) {
      if (cached && !navigator.onLine) {
        const parsed = JSON.parse(cached) as {
          members: Member[];
          expenses: Expense[];
          cycles: Cycle[];
        };
        setMembers(parsed.members);
        setExpenses(parsed.expenses);
        setCycles(parsed.cycles);
      } else setError(firstError.message);
      setDataLoading(false);
      return;
    }
    const loadedMembers = (memberResult.data ?? []) as Member[];
    const rows = expenseResult.data ?? [];
    const paths = rows.flatMap((row) =>
      row.image_path ? [row.image_path] : [],
    );
    const signed = paths.length
      ? await supabase.storage.from('receipts').createSignedUrls(paths, 3600)
      : { data: [] };
    const urls = new Map(
      (signed.data ?? []).map((item) => [item.path, item.signedUrl]),
    );
    const loadedExpenses = rows.map((row) => ({
      id: row.id,
      householdId: row.household_id,
      payerId: row.payer_member_id,
      payerName:
        loadedMembers.find((member) => member.id === row.payer_member_id)
          ?.name ??
        row.payer ??
        'Member',
      merchant: row.merchant,
      amount: Number(row.amount),
      category: row.category,
      receiptDate: row.receipt_date ?? row.created_at.slice(0, 10),
      createdAt: row.created_at,
      image: row.image_path
        ? (urls.get(row.image_path) ?? undefined)
        : undefined,
      imagePath: row.image_path ?? undefined,
      settled: Boolean(row.settled),
      ocrStatus: row.ocr_status ?? 'not_requested',
      ocrModel: row.ocr_model ?? undefined,
      notes: row.notes ?? '',
    }));
    const loadedCycles = (cycleResult.data ?? []).map((cycle) => ({
      ...cycle,
      total_amount: Number(cycle.total_amount),
      transfers: Array.isArray(cycle.transfers) ? cycle.transfers : [],
    })) as Cycle[];
    setMembers(loadedMembers);
    setExpenses(loadedExpenses);
    setCycles(loadedCycles);
    setActivities((activityResult.data ?? []) as Activity[]);
    setCustomCategories((categoryResult.data ?? []) as HouseholdCategory[]);
    setReceiptFlags((flagResult.data ?? []) as ReceiptFlag[]);
    setDataLoading(false);
    window.localStorage.setItem(
      `splitmate-data:${household.id}`,
      JSON.stringify({
        members: loadedMembers,
        expenses: loadedExpenses,
        cycles: loadedCycles,
      }),
    );
    const cutoff = new Date(Date.now() - 30_000).toISOString();
    const deleted = await supabase
      .from('expenses')
      .select('id,image_path')
      .eq('household_id', household.id)
      .not('deleted_at', 'is', null)
      .lt('deleted_at', cutoff);
    for (const row of deleted.data ?? []) {
      const storageResult = row.image_path
        ? await supabase.storage.from('receipts').remove([row.image_path])
        : { error: null };
      if (!storageResult.error)
        await supabase.from('expenses').delete().eq('id', row.id);
    }
  }, [household, online]);

  const syncOfflineReceipts = useCallback(async () => {
    if (!online || !user || !household) return;
    const queued = (await getOfflineReceipts()).filter(
      (receipt) =>
        receipt.userId === user.id && receipt.householdId === household.id,
    );
    let synced = 0;
    let failed = 0;
    for (const receipt of queued) {
      let imagePath: string | null = null;
      if (receipt.file) {
        imagePath = `${user.id}/${receipt.id}.jpg`;
        const upload = await supabase.storage
          .from('receipts')
          .upload(imagePath, receipt.file, {
            contentType: 'image/jpeg',
            upsert: false,
          });
        if (
          upload.error &&
          !upload.error.message.toLowerCase().includes('exist')
        ) {
          failed += 1;
          await saveOfflineReceipt({
            ...receipt,
            attempts: (receipt.attempts ?? 0) + 1,
            syncError: upload.error.message,
          });
          continue;
        }
      }
      const result = await supabase.from('expenses').insert({
        id: receipt.id,
        user_id: user.id,
        household_id: household.id,
        payer_member_id: receipt.payerId,
        payer: receipt.payerName,
        merchant: receipt.merchant,
        amount: receipt.amount,
        category: receipt.category,
        notes: receipt.notes || null,
        receipt_date: receipt.receiptDate,
        currency: 'AUD',
        image_path: imagePath,
        image_original_name: receipt.file?.name ?? null,
        image_mime_type: receipt.file?.type ?? null,
        image_size_bytes: receipt.file?.size ?? null,
        ocr_status: 'manual',
        verified_at: receipt.createdAt,
      });
      if (result.error && result.error.code !== '23505') {
        if (imagePath)
          await supabase.storage.from('receipts').remove([imagePath]);
        failed += 1;
        await saveOfflineReceipt({
          ...receipt,
          attempts: (receipt.attempts ?? 0) + 1,
          syncError: result.error.message,
        });
        continue;
      }
      await removeOfflineReceipt(receipt.id);
      synced += 1;
    }
    if (synced) {
      setRefreshKey((value) => value + 1);
      notify(`${synced} offline receipt${synced === 1 ? '' : 's'} synced`);
    }
    if (failed) {
      setExpenses((current) =>
        current.map((expense) =>
          queued.some((receipt) => receipt.id === expense.id)
            ? { ...expense, syncStatus: 'failed' }
            : expense,
        ),
      );
      notify(
        `${failed} receipt${failed === 1 ? '' : 's'} could not sync · tap Retry`,
      );
    }
  }, [online, user, household, notify]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
      setAuthLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!user || typeof PublicKeyCredential === 'undefined') return;
    let active = true;
    void supabase.auth.passkey.list().then(({ data, error: passkeyError }) => {
      if (active && !passkeyError)
        setPasskeyConfigured((data?.length ?? 0) > 0);
    });
    return () => {
      active = false;
    };
  }, [user]);
  useEffect(() => {
    window.localStorage.setItem('splitmate-theme', theme);
    if (theme === 'system')
      document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [tab]);
  useEffect(() => {
    if (!sheetOpen && !confirmDelete && !settlementReview) return;
    const scrollY = window.scrollY;
    const previous = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
    };
    Object.assign(document.body.style, {
      overflow: 'hidden',
      position: 'fixed',
      top: `-${scrollY}px`,
      width: '100%',
    });
    return () => {
      Object.assign(document.body.style, previous);
      window.scrollTo(0, scrollY);
    };
  }, [sheetOpen, confirmDelete, settlementReview]);
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      setRefreshKey((value) => value + 1);
    };
    const goOffline = () => setOnline(false);
    let registration: ServiceWorkerRegistration | undefined;
    const checkForUpdate = () => {
      if (document.visibilityState === 'visible') void registration?.update();
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    document.addEventListener('visibilitychange', checkForUpdate);
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker
        .register('/sw.js')
        .then((value) => {
          registration = value;
        })
        .catch((serviceWorkerError) =>
          console.error(
            '[SplitMate] service worker registration failed',
            serviceWorkerError,
          ),
        );
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      document.removeEventListener('visibilitychange', checkForUpdate);
    };
  }, []);
  useEffect(() => {
    queueMicrotask(() => void loadMembership());
  }, [loadMembership]);
  useEffect(() => {
    queueMicrotask(() => void loadData());
  }, [loadData, refreshKey]);
  useEffect(() => {
    if (!user || !household) return;
    if (online) {
      queueMicrotask(() => void syncOfflineReceipts());
      return;
    }
    void getOfflineReceipts().then((queued) => {
      const pending = queued
        .filter(
          (receipt) =>
            receipt.userId === user.id && receipt.householdId === household.id,
        )
        .map(
          (receipt): Expense => ({
            id: receipt.id,
            householdId: receipt.householdId,
            payerId: receipt.payerId,
            payerName: receipt.payerName,
            merchant: receipt.merchant,
            amount: receipt.amount,
            category: receipt.category,
            receiptDate: receipt.receiptDate,
            createdAt: receipt.createdAt,
            image: receipt.file ? URL.createObjectURL(receipt.file) : undefined,
            settled: false,
            ocrStatus: 'offline',
            notes: receipt.notes,
            syncStatus: receipt.syncError ? 'failed' : 'pending',
          }),
        );
      setExpenses((current) => [
        ...pending,
        ...current.filter(
          (expense) => !pending.some((item) => item.id === expense.id),
        ),
      ]);
    });
  }, [online, user, household, syncOfflineReceipts]);
  useEffect(() => {
    if (!household || tab !== 'household') return;
    const inviteUrl = `${window.location.origin}/?join=${household.join_code}`;
    void import('qrcode')
      .then(({ default: QRCode }) =>
        QRCode.toDataURL(inviteUrl, {
          width: 220,
          margin: 1,
          color: { dark: '#171a22', light: '#ffffff' },
        }),
      )
      .then(setQrCode);
  }, [household, tab]);
  useEffect(() => {
    if (!household) return;
    const channel = supabase
      .channel(`household:${household.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'expenses',
          filter: `household_id=eq.${household.id}`,
        },
        () => setRefreshKey((value) => value + 1),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'household_members',
          filter: `household_id=eq.${household.id}`,
        },
        () => setRefreshKey((value) => value + 1),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'settlement_cycles',
          filter: `household_id=eq.${household.id}`,
        },
        () => setRefreshKey((value) => value + 1),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'household_activity',
          filter: `household_id=eq.${household.id}`,
        },
        () => setRefreshKey((value) => value + 1),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'household_categories',
          filter: `household_id=eq.${household.id}`,
        },
        () => setRefreshKey((value) => value + 1),
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'receipt_flags',
          filter: `household_id=eq.${household.id}`,
        },
        () => setRefreshKey((value) => value + 1),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [household]);

  const now = new Date();
  const activeExpenses = useMemo(
    () => expenses.filter((expense) => !expense.settled),
    [expenses],
  );
  const total = useMemo(
    () => activeExpenses.reduce((sum, expense) => sum + expense.amount, 0),
    [activeExpenses],
  );
  const share = members.length ? total / members.length : 0;
  const transfers = useMemo(
    () =>
      calculateTransfers(
        members,
        activeExpenses.map((expense) => ({
          amount: expense.amount,
          payerId: expense.payerId,
        })),
      ),
    [members, activeExpenses],
  );
  const filteredExpenses = useMemo(
    () =>
      expenses.filter(
        (expense) =>
          expense.settled === (receiptFilter === 'settled') &&
          `${expense.merchant} ${expense.category} ${expense.payerName} ${expense.notes ?? ''}`
            .toLowerCase()
            .includes(search.trim().toLowerCase()),
      ),
    [expenses, receiptFilter, search],
  );
  const allCategories = useMemo(
    () => [
      ...defaultCategories,
      ...customCategories
        .map((category) => category.name)
        .filter((name) => !defaultCategories.includes(name)),
    ],
    [customCategories],
  );
  const isOwner = household?.created_by === user?.id;
  const isAdmin = self?.role === 'admin';
  const detailFlags = detail
    ? receiptFlags.filter((flag) => flag.expense_id === detail.id)
    : [];
  const greeting =
    now.getHours() < 12
      ? 'Good morning.'
      : now.getHours() < 18
        ? 'Good afternoon.'
        : 'Good evening.';
  const cycleLabel = new Intl.DateTimeFormat('en-AU', {
    month: 'long',
    year: 'numeric',
  }).format(now);

  const openUpload = useCallback(() => uploadRef.current?.click(), []);
  const openCamera = useCallback(() => cameraRef.current?.click(), []);
  const closeEditor = (keepUpload = false) => {
    activeScan.current = '';
    if (!keepUpload && draft.scanJobId) {
      cancelledScan.current = draft.scanJobId;
      void supabase
        .from('receipt_scan_jobs')
        .delete()
        .eq('id', draft.scanJobId);
    }
    if (!keepUpload && !detail && draft.imagePath) {
      void supabase.storage.from('receipts').remove([draft.imagePath]);
    }
    if (draft.image.startsWith('blob:')) URL.revokeObjectURL(draft.image);
    setSheetOpen(false);
    setSheetExpanded(false);
    setDetail(null);
    setDraft(blankDraft());
    setSwipedId(null);
  };
  const applyScanResult = useCallback(
    (data: Record<string, unknown>, jobId: string) => {
      if (activeScan.current !== jobId) return;
      const scannedDate =
        typeof data.receipt_date === 'string' ? data.receipt_date : '';
      const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(scannedDate)
        ? scannedDate
        : localDate();
      const amount =
        typeof data.total_amount === 'number' ||
        typeof data.total_amount === 'string'
          ? String(data.total_amount)
          : '';
      const merchant =
        typeof data.merchant === 'string' && data.merchant.trim()
          ? data.merchant
          : 'Receipt';
      const scannedCategory =
        typeof data.category === 'string' ? data.category : 'Other';
      const confidence = data.confidence as
        | { merchant?: number; amount?: number; date?: number }
        | undefined;
      setDraft((current) => ({
        ...current,
        merchant,
        amount,
        receiptDate,
        category: defaultCategories.includes(scannedCategory)
          ? scannedCategory
          : 'Other',
        ocrStatus: 'complete',
        ocrProcessedAt: new Date().toISOString(),
        lowConfidence: Boolean(
          confidence &&
          Math.min(
            confidence.merchant ?? 0,
            confidence.amount ?? 0,
            confidence.date ?? 0,
          ) < 0.72,
        ),
        duplicate: expenses.some(
          (expense) =>
            expense.receiptDate === receiptDate &&
            expense.merchant.toLowerCase() === merchant.toLowerCase() &&
            Math.abs(expense.amount - Number(amount)) < 0.01,
        ),
      }));
    },
    [expenses],
  );
  const scanFile = async (file: File, existingPath = '') => {
    if (!user || !household) return;
    setAnalyzing(true);
    const jobId = crypto.randomUUID();
    activeScan.current = jobId;
    let imagePath = existingPath;
    try {
      if (!imagePath) {
        imagePath = `${user.id}/scans/${jobId}.jpg`;
        const upload = await supabase.storage
          .from('receipts')
          .upload(imagePath, file, {
            contentType: 'image/jpeg',
            upsert: false,
          });
        if (upload.error) throw upload.error;
      }
      const created = await supabase.from('receipt_scan_jobs').insert({
        id: jobId,
        household_id: household.id,
        user_id: user.id,
        image_path: imagePath,
      });
      if (created.error) throw created.error;
      setDraft((current) => ({
        ...current,
        imagePath,
        scanJobId: jobId,
        ocrStatus: 'queued',
      }));
      const invoked = await supabase.functions.invoke('scan-receipt', {
        body: { jobId },
      });
      if (invoked.error || invoked.data?.error)
        throw invoked.error ?? new Error(invoked.data.error);
      let job: {
        status: string;
        result: Record<string, unknown> | null;
        error_message: string | null;
      } | null = null;
      for (let attempt = 0; attempt < 32; attempt += 1) {
        const response = await supabase
          .from('receipt_scan_jobs')
          .select('status,result,error_message')
          .eq('id', jobId)
          .single();
        if (response.error) throw response.error;
        job = response.data;
        if (job.status === 'complete' || job.status === 'failed') break;
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      if (!job || job.status === 'failed')
        throw new Error(
          job?.error_message || 'Scanning failed — enter the details manually',
        );
      if (job.status !== 'complete' || !job.result)
        throw new Error(
          'Scanning is still running. You can return to this receipt shortly.',
        );
      if (activeScan.current !== jobId) return;
      applyScanResult(job.result, jobId);
    } catch (scanError) {
      if (activeScan.current !== jobId) return;
      if (!existingPath && imagePath && !draft.imagePath)
        setDraft((current) => ({ ...current, imagePath }));
      setDraft((current) => ({
        ...current,
        ocrStatus: 'failed',
        ocrProcessedAt: new Date().toISOString(),
      }));
      notify(
        scanError instanceof Error
          ? scanError.message
          : 'Scanning failed — enter the details manually',
      );
    } finally {
      if (activeScan.current === jobId) setAnalyzing(false);
    }
  };
  const handleFile = async (original?: File) => {
    if (!original) return;
    try {
      const file = await prepareReceiptImage(original);
      const image = URL.createObjectURL(file);
      setDraft({
        ...blankDraft(),
        merchant: original.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
        receiptDate: localDate(),
        payerId: self?.id ?? '',
        image,
        file,
        ocrStatus: online ? 'queued' : 'offline',
      });
      setSheetExpanded(false);
      setSheetOpen(true);
      setDetail(null);
      if (online) await scanFile(file);
      else notify('Offline — enter the total and this receipt will sync later');
    } catch (imageError) {
      notify(
        imageError instanceof Error
          ? imageError.message
          : 'Could not open that image',
      );
    } finally {
      if (uploadRef.current) uploadRef.current.value = '';
      if (cameraRef.current) cameraRef.current.value = '';
    }
  };
  const openDetail = (expense: Expense) => {
    if (expense.syncStatus) {
      notify(
        expense.syncStatus === 'failed'
          ? 'Sync failed · reconnect and tap Retry'
          : 'This receipt will be available after it syncs',
      );
      return;
    }
    setDetail(expense);
    setFlagReason('');
    setDraft({
      ...blankDraft(),
      merchant: expense.merchant,
      amount: String(expense.amount),
      category: expense.category,
      receiptDate: expense.receiptDate,
      payerId: expense.payerId,
      image: expense.image ?? '',
      imagePath: expense.imagePath ?? '',
      notes: expense.notes ?? '',
      ocrStatus: expense.ocrStatus,
    });
    setSheetExpanded(false);
    setSheetOpen(true);
  };
  const saveExpense = async () => {
    const amount = Number(draft.amount);
    if (
      !user ||
      !household ||
      !draft.payerId ||
      !draft.merchant.trim() ||
      !(amount > 0) ||
      (detail && !isAdmin)
    )
      return;
    const payer = members.find((member) => member.id === draft.payerId);
    const expenseId = detail?.id ?? crypto.randomUUID();
    if (!online && !detail) {
      const queued: OfflineReceipt = {
        id: expenseId,
        userId: user.id,
        householdId: household.id,
        payerId: draft.payerId,
        payerName: payer?.name ?? 'Member',
        merchant: draft.merchant.trim(),
        amount,
        category: draft.category,
        receiptDate: draft.receiptDate || localDate(),
        notes: draft.notes.trim(),
        file: draft.file,
        createdAt: new Date().toISOString(),
      };
      await saveOfflineReceipt(queued);
      setExpenses((current) => [
        {
          id: queued.id,
          householdId: queued.householdId,
          payerId: queued.payerId,
          payerName: queued.payerName,
          merchant: queued.merchant,
          amount: queued.amount,
          category: queued.category,
          receiptDate: queued.receiptDate,
          createdAt: queued.createdAt,
          image: queued.file ? URL.createObjectURL(queued.file) : undefined,
          settled: false,
          ocrStatus: 'offline',
          notes: queued.notes,
          syncStatus: 'pending',
        },
        ...current,
      ]);
      closeEditor(true);
      notify('Saved offline · will sync automatically');
      return;
    }
    setSaving(true);
    let imagePath: string | null = draft.imagePath || detail?.imagePath || null;
    try {
      if (!detail && draft.file && !imagePath) {
        imagePath = `${user.id}/${expenseId}.jpg`;
        const upload = await supabase.storage
          .from('receipts')
          .upload(imagePath, draft.file, {
            contentType: 'image/jpeg',
            upsert: false,
          });
        if (upload.error) throw upload.error;
      }
      const payload = {
        household_id: household.id,
        payer_member_id: draft.payerId,
        payer: payer?.name ?? 'Member',
        merchant: draft.merchant.trim(),
        amount,
        category: draft.category,
        notes: draft.notes.trim() || null,
        receipt_date: draft.receiptDate || null,
        verified_at: new Date().toISOString(),
        ocr_status: draft.ocrStatus === 'failed' ? 'manual' : draft.ocrStatus,
        ocr_processed_at: draft.ocrProcessedAt,
        ocr_model:
          draft.ocrStatus === 'complete'
            ? 'gemini-3.7-flash'
            : (detail?.ocrModel ?? null),
      };
      const result = detail
        ? await supabase.from('expenses').update(payload).eq('id', detail.id)
        : await supabase.from('expenses').insert({
            ...payload,
            id: expenseId,
            user_id: user.id,
            currency: 'AUD',
            image_path: imagePath,
            image_original_name: draft.file?.name ?? null,
            image_mime_type: draft.file?.type ?? null,
            image_size_bytes: draft.file?.size ?? null,
          });
      if (result.error) throw result.error;
      if (draft.scanJobId)
        await supabase
          .from('receipt_scan_jobs')
          .delete()
          .eq('id', draft.scanJobId);
      closeEditor(true);
      setRefreshKey((value) => value + 1);
      notify(detail ? 'Receipt updated' : 'Receipt added');
    } catch (saveError) {
      if (!detail && imagePath)
        await supabase.storage.from('receipts').remove([imagePath]);
      if (draft.scanJobId)
        await supabase
          .from('receipt_scan_jobs')
          .delete()
          .eq('id', draft.scanJobId);
      notify(
        saveError instanceof Error
          ? saveError.message
          : 'Could not save receipt',
      );
    } finally {
      setSaving(false);
    }
  };
  const rescanDetail = async () => {
    if (!isAdmin) return;
    if (draft.file) {
      await scanFile(draft.file, detail?.imagePath);
      return;
    }
    if (!detail?.imagePath) return;
    const result = await supabase.storage
      .from('receipts')
      .download(detail.imagePath);
    if (result.error) {
      notify(result.error.message);
      return;
    }
    await scanFile(
      new File([result.data], 'receipt.jpg', {
        type: result.data.type || 'image/jpeg',
      }),
      detail.imagePath,
    );
  };
  const purgeExpense = async (expense: Expense) => {
    const storageResult = expense.imagePath
      ? await supabase.storage.from('receipts').remove([expense.imagePath])
      : { error: null };
    if (!storageResult.error)
      await supabase.from('expenses').delete().eq('id', expense.id);
    if (pendingDelete.current?.expense.id === expense.id)
      pendingDelete.current = null;
  };
  const deleteExpense = async (expense: Expense) => {
    if (!isAdmin && expense.syncStatus !== 'pending') {
      notify('Only an admin can delete receipts');
      return;
    }
    if (expense.syncStatus === 'pending') {
      await removeOfflineReceipt(expense.id);
      setExpenses((current) =>
        current.filter((item) => item.id !== expense.id),
      );
      notify('Offline receipt removed');
      return;
    }
    if (pendingDelete.current) {
      window.clearTimeout(pendingDelete.current.timer);
      await purgeExpense(pendingDelete.current.expense);
    }
    const result = await supabase
      .from('expenses')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', expense.id);
    if (result.error) {
      notify(result.error.message);
      return;
    }
    setExpenses((current) => current.filter((item) => item.id !== expense.id));
    closeEditor();
    const undo = async () => {
      if (pendingDelete.current?.expense.id !== expense.id) return;
      window.clearTimeout(pendingDelete.current.timer);
      pendingDelete.current = null;
      const restored = await supabase
        .from('expenses')
        .update({ deleted_at: null })
        .eq('id', expense.id);
      if (restored.error) notify(restored.error.message);
      else {
        setRefreshKey((value) => value + 1);
        notify('Receipt restored');
      }
    };
    const timer = window.setTimeout(() => void purgeExpense(expense), 5200);
    pendingDelete.current = { expense, timer };
    notify('Receipt deleted', { label: 'Undo', run: () => void undo() }, 5000);
  };
  const requestDelete = (expense: Expense) => {
    setSwipedId(null);
    setConfirmDelete(expense);
  };
  const settleCycle = async () => {
    if (!isAdmin || !household || !activeExpenses.length) return;
    setSaving(true);
    const result = await supabase.rpc('settle_household', {
      target_household: household.id,
      transfer_summary: transfers,
    });
    setSaving(false);
    if (result.error) notify(result.error.message);
    else {
      setSettlementReview(false);
      setRefreshKey((value) => value + 1);
      notify('Cycle settled');
    }
  };
  const shareSettlement = async () => {
    if (!isAdmin) return;
    const text = `${household?.name ?? 'Household'} settlement\n${transfers.length ? transfers.map((transfer) => `${transfer.from} pays ${transfer.to} ${money.format(transfer.amount)}`).join('\n') : 'Everyone is even.'}`;
    if (navigator.share)
      await navigator.share({ title: 'SplitMate settlement', text });
    else {
      await navigator.clipboard.writeText(text);
      notify('Settlement copied');
    }
  };
  const registerPasskey = async () => {
    if (passkeyConfigured) {
      notify('A passkey is already set up');
      return;
    }
    setPasskeyBusy(true);
    try {
      const result = await supabase.auth.registerPasskey();
      if (result.error) {
        if (result.error.code === 'webauthn_credential_exists') {
          setPasskeyConfigured(true);
          notify('This passkey is already set up');
        } else notify(result.error.message);
      } else {
        setPasskeyConfigured(true);
        notify('Face ID or passkey is ready');
      }
    } catch (passkeyError) {
      notify(
        passkeyError instanceof Error
          ? passkeyError.message
          : 'Passkey setup was cancelled',
      );
    } finally {
      setPasskeyBusy(false);
    }
  };
  const inviteUrl = household
    ? `${window.location.origin}/?join=${household.join_code}`
    : '';
  const shareInvite = async () => {
    if (!isAdmin) return;
    const text = `Join ${household?.name ?? 'my household'} on SplitMate: ${inviteUrl}`;
    if (navigator.share)
      await navigator.share({
        title: 'Join my SplitMate household',
        text,
        url: inviteUrl,
      });
    else {
      await navigator.clipboard.writeText(inviteUrl);
      notify('Invite link copied');
    }
  };
  const saveProfileName = async () => {
    if (!self || profileName.trim() === self.name) return;
    const result = await supabase.rpc('rename_self', {
      target_member: self.id,
      new_name: profileName,
    });
    if (result.error) notify(result.error.message);
    else {
      setRefreshKey((value) => value + 1);
      void loadMembership();
      notify('Name updated');
    }
  };
  const saveHouseholdName = async () => {
    if (
      !isAdmin ||
      !user ||
      !household ||
      householdName.trim() === household.name
    )
      return;
    const result = await supabase.rpc('rename_household', {
      target_household: household.id,
      new_name: householdName,
    });
    if (result.error) notify(result.error.message);
    else {
      window.localStorage.removeItem(`splitmate-membership:${user.id}`);
      await loadMembership();
      notify('Household renamed');
    }
  };
  const addCategory = async () => {
    if (!isAdmin || !user || !household || !newCategory.trim()) return;
    const result = await supabase.from('household_categories').insert({
      household_id: household.id,
      name: newCategory.trim(),
      created_by: user.id,
    });
    if (result.error) notify(result.error.message);
    else {
      setNewCategory('');
      setRefreshKey((value) => value + 1);
      notify('Category added');
    }
  };
  const deleteCategory = async (category: HouseholdCategory) => {
    const result = await supabase
      .from('household_categories')
      .delete()
      .eq('id', category.id);
    if (result.error) notify(result.error.message);
    else setRefreshKey((value) => value + 1);
  };
  const regenerateInvite = async () => {
    if (
      !isAdmin ||
      !user ||
      !household ||
      !window.confirm(
        'Replace the current invite code? The old link will stop working.',
      )
    )
      return;
    const result = await supabase.rpc('regenerate_household_invite', {
      target_household: household.id,
    });
    if (result.error) notify(result.error.message);
    else {
      window.localStorage.removeItem(`splitmate-membership:${user.id}`);
      await loadMembership();
      notify('New invite created');
    }
  };
  const removeMember = async (member: Member) => {
    if (
      !isAdmin ||
      !window.confirm(`Remove ${member.name} from this household?`)
    )
      return;
    const result = await supabase.rpc('remove_household_member', {
      target_member: member.id,
    });
    if (result.error) notify(result.error.message);
    else {
      setRefreshKey((value) => value + 1);
      notify(`${member.name} removed`);
    }
  };
  const changeMemberRole = async (member: Member, role: Member['role']) => {
    if (!isAdmin || !user || member.role === role) return;
    const result = await supabase.rpc('set_household_member_role', {
      target_member: member.id,
      new_role: role,
    });
    if (result.error) notify(result.error.message);
    else {
      if (member.user_id === user.id)
        window.localStorage.removeItem(`splitmate-membership:${user.id}`);
      await loadMembership();
      setRefreshKey((value) => value + 1);
      notify(
        `${member.name} is now ${role === 'admin' ? 'an admin' : 'a user'}`,
      );
    }
  };
  const reportIncorrect = async () => {
    if (!detail) return;
    const result = await supabase.rpc('report_receipt_incorrect', {
      target_expense: detail.id,
      report_reason: flagReason.trim() || null,
    });
    if (result.error) notify(result.error.message);
    else {
      setFlagReason('');
      setRefreshKey((value) => value + 1);
      notify('Admin notified');
    }
  };
  const resolveFlag = async (flag: ReceiptFlag) => {
    if (!isAdmin) return;
    const result = await supabase.rpc('resolve_receipt_flag', {
      target_flag: flag.id,
    });
    if (result.error) notify(result.error.message);
    else {
      setRefreshKey((value) => value + 1);
      notify('Report resolved');
    }
  };
  const leaveHousehold = async () => {
    if (
      !user ||
      !household ||
      !window.confirm(
        isOwner
          ? 'Delete this household? This cannot be undone.'
          : 'Leave this household?',
      )
    )
      return;
    const result = await supabase.rpc('leave_household', {
      target_household: household.id,
    });
    if (result.error) notify(result.error.message);
    else {
      window.localStorage.removeItem(`splitmate-membership:${user.id}`);
      currentHouseholdId.current = null;
      setHousehold(null);
      setSelf(null);
      setDataLoading(true);
      await loadMembership();
    }
  };
  const exportExpenses = () => {
    const cell = (value: string | number) =>
      `"${String(value).replace(/"/g, '""')}"`;
    const rows = [
      [
        'Date',
        'Merchant',
        'Amount AUD',
        'Category',
        'Paid by',
        'Status',
        'Notes',
      ],
      ...expenses.map((expense) => [
        expense.receiptDate,
        expense.merchant,
        expense.amount.toFixed(2),
        expense.category,
        expense.payerName,
        expense.settled ? 'Settled' : 'Current',
        expense.notes ?? '',
      ]),
    ];
    const blob = new Blob(
      [rows.map((row) => row.map(cell).join(',')).join('\r\n')],
      { type: 'text/csv;charset=utf-8' },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `splitmate-${household?.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'household'}-${localDate()}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    notify('Expense export downloaded');
  };
  const deleteAccount = async () => {
    if (
      !window.confirm(
        'Permanently delete your SplitMate account? Shared household records will be preserved when other members remain. This cannot be undone.',
      )
    )
      return;
    setDeletingAccount(true);
    const result = await supabase.functions.invoke('delete-account', {
      body: { confirm: true },
    });
    if (result.error || result.data?.error) {
      notify(
        result.data?.error ??
          result.error?.message ??
          'Account could not be deleted',
      );
      setDeletingAccount(false);
      return;
    }
    window.localStorage.clear();
    await supabase.auth.signOut();
  };
  const receiptRow = (expense: Expense) => {
    const payer =
      members.find((member) => member.id === expense.payerId) ?? self;
    const isOpen = !expense.settled && swipedId === expense.id;
    return (
      <ReceiptRow
        key={expense.id}
        expense={expense}
        payer={payer}
        isAdmin={isAdmin}
        hasFlag={receiptFlags.some((flag) => flag.expense_id === expense.id)}
        isOpen={isOpen}
        onOpen={() => openDetail(expense)}
        onCloseSwipe={() => setSwipedId(null)}
        onOpenSwipe={() => setSwipedId(expense.id)}
        onDelete={() => requestDelete(expense)}
      />
    );
  };

  useEffect(() => {
    if (!online || !user || !household || !self) return;
    let stopped = false;
    void (async () => {
      const latest = await supabase
        .from('receipt_scan_jobs')
        .select('id,image_path,status,result,error_message')
        .eq('user_id', user.id)
        .eq('household_id', household.id)
        .in('status', ['queued', 'processing', 'complete'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (stopped || !latest.data || latest.data.id === cancelledScan.current)
        return;
      const job = latest.data;
      activeScan.current = job.id;
      const signed = await supabase.storage
        .from('receipts')
        .createSignedUrl(job.image_path, 3600);
      setDetail(null);
      setDraft({
        ...blankDraft(),
        merchant: 'Receipt',
        receiptDate: localDate(),
        payerId: self.id,
        image: signed.data?.signedUrl ?? '',
        imagePath: job.image_path,
        scanJobId: job.id,
        ocrStatus: job.status,
      });
      setSheetOpen(true);
      if (job.status === 'complete' && job.result) {
        applyScanResult(job.result as Record<string, unknown>, job.id);
        return;
      }
      setAnalyzing(true);
      if (job.status === 'queued')
        await supabase.functions.invoke('scan-receipt', {
          body: { jobId: job.id },
        });
      for (let attempt = 0; attempt < 32 && !stopped; attempt += 1) {
        const response = await supabase
          .from('receipt_scan_jobs')
          .select('status,result,error_message')
          .eq('id', job.id)
          .single();
        if (response.data?.status === 'complete' && response.data.result) {
          applyScanResult(
            response.data.result as Record<string, unknown>,
            job.id,
          );
          break;
        }
        if (response.data?.status === 'failed') {
          notify(response.data.error_message || 'Receipt scan failed');
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
      if (!stopped) setAnalyzing(false);
    })();
    return () => {
      stopped = true;
    };
  }, [online, user, household, self, applyScanResult, notify]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'start_receipt_creation',
          title: 'Add a household receipt',
          description: 'Open Photos to choose and scan a household bill.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false },
          execute: () => {
            openUpload();
            return { status: 'photo_picker_opened' };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [openUpload]);

  if (authLoading)
    return (
      <main className="loading-screen">
        <Image
          className="brand-logo loading-logo"
          src="/app-icon.svg"
          alt="SplitMate"
          width={180}
          height={180}
          priority
        />
        <span className="loader" />
        <p>Opening SplitMate…</p>
      </main>
    );
  if (!user) return <AuthScreen />;
  if (loading || (household && self && dataLoading))
    return (
      <main className="loading-screen">
        <Image
          className="brand-logo loading-logo"
          src="/app-icon.svg"
          alt="SplitMate"
          width={180}
          height={180}
          priority
        />
        <span className="loader" />
        <p>Loading your household…</p>
      </main>
    );
  if (!household || !self)
    return <HouseholdSetup user={user} onReady={() => void loadMembership()} />;

  return (
    <main className="app-shell">
      <input
        ref={uploadRef}
        className="hidden"
        type="file"
        accept="image/*"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      <input
        ref={cameraRef}
        className="hidden"
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      {!online && (
        <div className="network-banner">
          <WifiOff size={15} /> Offline · bills save on this iPhone
        </div>
      )}
      <div className="app-frame">
        <AppHeader
          householdName={household.name}
          title={
            tab === 'home'
              ? greeting
              : tab === 'receipts'
                ? 'Receipts'
                : tab === 'insights'
                  ? 'Insights'
                  : tab === 'household'
                    ? 'Household'
                    : 'Settings'
          }
          showCapture={tab === 'home' || tab === 'receipts'}
          onCamera={openCamera}
          onUpload={openUpload}
        />
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setRefreshKey((value) => value + 1)}>
              Retry
            </button>
          </div>
        )}
        {tab === 'home' && (
          <HomeView
            cycleLabel={cycleLabel}
            total={total}
            share={share}
            members={members}
            expenses={expenses}
            activeExpenses={activeExpenses}
            online={online}
            transfers={transfers}
            isAdmin={isAdmin}
            saving={saving}
            onUpload={openUpload}
            onRetrySync={() => void syncOfflineReceipts()}
            onShowReceipts={() => setTab('receipts')}
            onShare={() => void shareSettlement()}
            onReviewSettlement={() => setSettlementReview(true)}
            renderReceipt={receiptRow}
          />
        )}
        {tab === 'receipts' && (
          <ReceiptsView
            search={search}
            filter={receiptFilter}
            expenses={expenses}
            filteredExpenses={filteredExpenses}
            onSearch={setSearch}
            onFilter={setReceiptFilter}
            renderReceipt={receiptRow}
          />
        )}
        {tab === 'insights' && (
          <Suspense
            fallback={
              <section className="single-column insights-page">
                <div
                  className="insights-loading"
                  aria-label="Loading insights"
                />
              </section>
            }
          >
            <InsightsView
              expenses={expenses}
              members={members}
              cycles={cycles}
            />
          </Suspense>
        )}
        {tab === 'household' && (
          <HouseholdView
            household={household}
            members={members}
            self={self}
            activities={activities}
            isAdmin={isAdmin}
            qrCode={qrCode}
            onShareInvite={() => void shareInvite()}
            onRegenerateInvite={() => void regenerateInvite()}
            onRoleChange={(member, role) => void changeMemberRole(member, role)}
            onRemoveMember={(member) => void removeMember(member)}
          />
        )}
        {tab === 'settings' && (
          <SettingsView
            user={user}
            self={self}
            household={household}
            isAdmin={isAdmin}
            isOwner={isOwner}
            profileName={profileName}
            householdName={householdName}
            newCategory={newCategory}
            categories={customCategories}
            theme={theme}
            passkeyConfigured={passkeyConfigured}
            passkeyBusy={passkeyBusy}
            deletingAccount={deletingAccount}
            onProfileName={setProfileName}
            onHouseholdName={setHouseholdName}
            onNewCategory={setNewCategory}
            onTheme={setTheme}
            onSaveProfile={() => void saveProfileName()}
            onSaveHousehold={() => void saveHouseholdName()}
            onAddCategory={() => void addCategory()}
            onDeleteCategory={(category) => void deleteCategory(category)}
            onRegisterPasskey={() => void registerPasskey()}
            onExport={exportExpenses}
            onLeave={() => void leaveHousehold()}
            onDeleteAccount={() => void deleteAccount()}
            onSignOut={() => void supabase.auth.signOut()}
          />
        )}
        <SettlementReview
          open={settlementReview}
          expenses={activeExpenses}
          total={total}
          transfers={transfers}
          saving={saving}
          onCancel={() => setSettlementReview(false)}
          onConfirm={() => void settleCycle()}
        />
      </div>
      <BottomNavigation active={tab} onChange={setTab} />
      <ReceiptEditor
        open={sheetOpen}
        expanded={sheetExpanded}
        saving={saving}
        analyzing={analyzing}
        online={online}
        isAdmin={isAdmin}
        userId={user.id}
        draft={draft}
        detail={detail}
        flags={detailFlags}
        members={members}
        categories={allCategories}
        flagReason={flagReason}
        onExpandedChange={setSheetExpanded}
        onDraftChange={setDraft}
        onFlagReasonChange={setFlagReason}
        onClose={() => closeEditor()}
        onDelete={requestDelete}
        onResolveFlag={(flag) => void resolveFlag(flag)}
        onReportIncorrect={() => void reportIncorrect()}
        onRescan={() => void rescanDetail()}
        onSave={() => void saveExpense()}
      />
      <DeleteConfirmation
        expense={confirmDelete}
        onCancel={() => setConfirmDelete(null)}
        onConfirm={(expense) => {
          setConfirmDelete(null);
          void deleteExpense(expense);
        }}
      />
      <AppToast toast={toast} />
    </main>
  );
}
