// @ts-expect-error Supabase Edge Functions resolve Deno npm specifiers at deploy time.
import { createClient } from 'npm:@supabase/supabase-js@2';

declare const Deno: { env: { get: (name: string) => string | undefined }; serve: (handler: (request: Request) => Response | Promise<Response>) => void };

const allowedOrigins = new Set([Deno.env.get('APP_ORIGIN') || 'https://ourpersonalbill.netlify.app', 'http://localhost:3000']);
const headers = (request: Request) => {
  const origin = request.headers.get('Origin');
  return { 'Access-Control-Allow-Origin': origin && allowedOrigins.has(origin) ? origin : Deno.env.get('APP_ORIGIN') || 'https://ourpersonalbill.netlify.app', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Vary': 'Origin' };
};

Deno.serve(async (request) => {
  const cors = headers(request); const origin = request.headers.get('Origin');
  if (origin && !allowedOrigins.has(origin)) return Response.json({ error: 'Origin not allowed' }, { status: 403, headers: cors });
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: cors });
  const authorization = request.headers.get('Authorization');
  if (!authorization) return Response.json({ error: 'Sign in required' }, { status: 401, headers: cors });

  const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const identity = await userClient.auth.getUser();
  if (identity.error || !identity.data.user) return Response.json({ error: 'Sign in required' }, { status: 401, headers: cors });
  const body = await request.json().catch(() => ({})) as { confirm?: boolean };
  if (body.confirm !== true) return Response.json({ error: 'Deletion confirmation required' }, { status: 400, headers: cors });

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const userId = identity.data.user.id;
  try {
    const membership = await admin.from('household_members').select('id,household_id').eq('user_id', userId).is('left_at', null).maybeSingle();
    if (membership.error) throw membership.error;
    if (membership.data) {
      const members = await admin.from('household_members').select('id,user_id,role,joined_at').eq('household_id', membership.data.household_id).is('left_at', null).order('joined_at');
      if (members.error) throw members.error;
      const others = (members.data ?? []).filter((member: { user_id: string }) => member.user_id !== userId);
      if (!others.length) {
        const files = await admin.storage.from('receipts').list(userId, { limit: 1000 });
        const rootPaths = (files.data ?? []).filter((file: { id?: string | null }) => file.id).map((file: { name: string }) => `${userId}/${file.name}`);
        const scans = await admin.storage.from('receipts').list(`${userId}/scans`, { limit: 1000 });
        const scanPaths = (scans.data ?? []).filter((file: { id?: string | null }) => file.id).map((file: { name: string }) => `${userId}/scans/${file.name}`);
        if (rootPaths.length || scanPaths.length) await admin.storage.from('receipts').remove([...rootPaths, ...scanPaths]);
        const removed = await admin.from('households').delete().eq('id', membership.data.household_id); if (removed.error) throw removed.error;
      } else {
        const successor = others.find((member: { role: string }) => member.role === 'admin') ?? others[0];
        const moved = await admin.from('expenses').update({ user_id: successor.user_id }).eq('household_id', membership.data.household_id).eq('user_id', userId); if (moved.error) throw moved.error;
        const owner = await admin.from('households').update({ created_by: successor.user_id }).eq('id', membership.data.household_id).eq('created_by', userId); if (owner.error) throw owner.error;
        const removed = await admin.from('household_members').update({ user_id: null, left_at: new Date().toISOString(), name: 'Former member', role: 'user' }).eq('id', membership.data.id); if (removed.error) throw removed.error;
      }
    }
    const deletion = await admin.auth.admin.deleteUser(userId);
    if (deletion.error) throw deletion.error;
    return Response.json({ deleted: true }, { headers: { ...cors, 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Account could not be deleted' }, { status: 400, headers: cors });
  }
});
