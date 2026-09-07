export type OfflineReceipt = {
  id: string;
  userId: string;
  householdId: string;
  payerId: string;
  payerName: string;
  merchant: string;
  amount: number;
  category: string;
  receiptDate: string;
  notes: string;
  file: File | null;
  createdAt: string;
  attempts?: number;
  syncError?: string;
};

const databaseName = 'splitmate-offline';
const storeName = 'receipts';

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(storeName, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = run(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => database.close();
  });
}

export const saveOfflineReceipt = (receipt: OfflineReceipt) =>
  transact('readwrite', (store) => store.put(receipt));
export const removeOfflineReceipt = (id: string) =>
  transact('readwrite', (store) => store.delete(id));
export const getOfflineReceipts = () =>
  transact<OfflineReceipt[]>('readonly', (store) => store.getAll());
