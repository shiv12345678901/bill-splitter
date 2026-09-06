'use client';

import { useEffect } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[SplitMate] unrecoverable render error', error); }, [error]);

  return <main className="fatal-error" role="alert"><section><span><TriangleAlert size={27} /></span><h1>SplitMate needs to reload</h1><p>Your receipts remain securely saved. Reload the app to recover.</p><button onClick={reset}><RefreshCw size={18} /> Reload app</button><details><summary>Technical details</summary><p>{error.message}</p></details></section></main>;
}
