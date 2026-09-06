import { createClient } from '@supabase/supabase-js';

// These values are public browser credentials. Environment variables can
// override them, while the fallbacks keep static Netlify exports configured.
const url =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  'https://ttsnhrbxapirykvigwgp.supabase.co';
const anonKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  'sb_publishable_VYubp5grHb0ne_AG3rDPFA_1JdlJ_Zb';

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
