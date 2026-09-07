'use client';

import { useState } from 'react';
import Image from 'next/image';
import {
  ArrowRight,
  Fingerprint,
  ImagePlus,
  Mail,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { supabase, supabaseConfigured } from '@/lib/supabase';

export function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [emailName, setEmailName] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const email = `${emailName.trim()}@gmail.com`;
  const submit = async (event: React.SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setStatus('');
    const result =
      mode === 'signin'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({
            email,
            password,
            options: { emailRedirectTo: window.location.href },
          });
    setBusy(false);
    if (result.error) setStatus(result.error.message);
    else if (mode === 'signup' && !result.data.session)
      setStatus('Check your email to confirm your account.');
  };
  const resetPassword = async () => {
    if (!emailName.trim()) {
      setStatus('Enter your Gmail username first.');
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    setStatus(error?.message ?? 'Password reset link sent.');
  };
  const passkeySignIn = async () => {
    setBusy(true);
    setStatus('');
    try {
      const result = await supabase.auth.signInWithPasskey();
      if (result.error) setStatus(result.error.message);
    } catch (passkeyError) {
      setStatus(
        passkeyError instanceof Error
          ? passkeyError.message
          : 'Passkey sign-in was cancelled.',
      );
    } finally {
      setBusy(false);
    }
  };
  const updateEmailName = (value: string) =>
    setEmailName(
      value
        .trim()
        .replace(/@gmail\.com$/i, '')
        .replace(/@.*$/, ''),
    );
  return (
    <main className="auth-shell">
      <section className="auth-card intro-card">
        <Image
          className="brand-logo"
          src="/app-icon.svg"
          alt="SplitMate"
          width={180}
          height={180}
          priority
        />
        <p className="eyebrow">SplitMate</p>
        <h1>
          Scan. Split.
          <br />
          Settle.
        </h1>
        <p className="auth-copy">
          The private household bill app designed to feel at home on your
          iPhone.
        </p>
        <div className="intro-points">
          <span>
            <ImagePlus size={17} /> Scan bills from Photos
          </span>
          <span>
            <Users size={17} /> Share every cost equally
          </span>
          <span>
            <ShieldCheck size={17} /> Private and securely synced
          </span>
        </div>
        {!supabaseConfigured ? (
          <div className="auth-alert">Supabase is not connected yet.</div>
        ) : (
          <>
            <form onSubmit={submit} className="auth-form">
              <label className="auth-field gmail-field">
                <Mail size={18} />
                <input
                  aria-label="Gmail username"
                  required
                  type="text"
                  inputMode="email"
                  autoComplete="username"
                  value={emailName}
                  onChange={(event) => updateEmailName(event.target.value)}
                  placeholder="yourname"
                />
                <span>@gmail.com</span>
              </label>
              <label className="auth-field">
                <input
                  aria-label="Password"
                  required
                  minLength={6}
                  type="password"
                  autoComplete={
                    mode === 'signin' ? 'current-password' : 'new-password'
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Password"
                />
              </label>
              {status && <output className="auth-alert">{status}</output>}
              <button disabled={busy} className="primary-button">
                {busy
                  ? 'Please wait…'
                  : mode === 'signin'
                    ? 'Sign in'
                    : 'Create account'}{' '}
                <ArrowRight size={17} />
              </button>
            </form>
            {mode === 'signin' &&
              typeof PublicKeyCredential !== 'undefined' && (
                <>
                  <div className="auth-divider">
                    <span />
                    or
                    <span />
                  </div>
                  <button
                    disabled={busy}
                    onClick={() => void passkeySignIn()}
                    className="passkey-button"
                  >
                    <Fingerprint size={21} /> Use Face ID or passkey
                  </button>
                </>
              )}
          </>
        )}
        <button
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin');
            setStatus('');
          }}
          className="text-button"
        >
          {mode === 'signin'
            ? 'Create an account'
            : 'Already have an account? Sign in'}
        </button>
        {mode === 'signin' && (
          <button
            onClick={() => void resetPassword()}
            className="text-button muted"
          >
            Forgot password?
          </button>
        )}
      </section>
    </main>
  );
}
