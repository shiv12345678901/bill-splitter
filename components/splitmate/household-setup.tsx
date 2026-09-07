'use client';

import { useState } from 'react';
import { Users } from 'lucide-react';
import type { User } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { userError } from '@/lib/user-error';

export function HouseholdSetup({
  user,
  onReady,
}: {
  user: User;
  onReady: () => void;
}) {
  const invitedCode =
    typeof window === 'undefined'
      ? ''
      : (new URLSearchParams(window.location.search)
          .get('join')
          ?.toUpperCase() ?? '');
  const [memberName, setMemberName] = useState(
    user.email?.split('@')[0] ?? 'Me',
  );
  const [householdName, setHouseholdName] = useState('Home');
  const [joinCode, setJoinCode] = useState(invitedCode);
  const [mode, setMode] = useState<'create' | 'join'>(
    invitedCode ? 'join' : 'create',
  );
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    const result =
      mode === 'create'
        ? await supabase.rpc('create_household', {
            household_name: householdName,
            member_name: memberName,
          })
        : await supabase.rpc('join_household', {
            code: joinCode,
            member_name: memberName,
          });
    setBusy(false);
    if (result.error)
      setStatus(
        userError(
          result.error,
          'The household could not be created or joined.',
        ),
      );
    else onReady();
  };
  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="auth-mark">
          <Users size={26} />
        </div>
        <p className="eyebrow">One quick step</p>
        <h1>
          {mode === 'create'
            ? 'Create your household.'
            : 'Join your household.'}
        </h1>
        <p className="auth-copy">
          Everyone in the household shares every expense equally.
        </p>
        <form onSubmit={submit} className="auth-form">
          <label className="field-label">
            Your name
            <input
              required
              maxLength={50}
              className="field-input"
              value={memberName}
              onChange={(event) => setMemberName(event.target.value)}
            />
          </label>
          {mode === 'create' ? (
            <label className="field-label">
              Household name
              <input
                required
                maxLength={60}
                className="field-input"
                value={householdName}
                onChange={(event) => setHouseholdName(event.target.value)}
              />
            </label>
          ) : (
            <label className="field-label">
              8-character join code
              <input
                required
                maxLength={8}
                autoCapitalize="characters"
                className="field-input code-input"
                value={joinCode}
                onChange={(event) =>
                  setJoinCode(event.target.value.toUpperCase())
                }
              />
            </label>
          )}
          {status && <output className="auth-alert">{status}</output>}
          <button disabled={busy} className="primary-button">
            {busy
              ? 'Please wait…'
              : mode === 'create'
                ? 'Create household'
                : 'Join household'}
          </button>
        </form>
        <button
          className="text-button"
          onClick={() => {
            setMode(mode === 'create' ? 'join' : 'create');
            setStatus('');
          }}
        >
          {mode === 'create' ? 'I have a join code' : 'Create a new household'}
        </button>
      </section>
    </main>
  );
}
