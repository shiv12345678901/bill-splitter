// @ts-expect-error Supabase Edge Functions resolve Deno npm specifiers at deploy time.
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

declare const Deno: {
  env: { get: (name: string) => string | undefined };
  serve: (handler: (request: Request) => Response | Promise<Response>) => void;
};
declare const EdgeRuntime: { waitUntil: (promise: Promise<unknown>) => void } | undefined;

const categories = ['Groceries', 'Utilities', 'Household', 'Dining', 'Other'];

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32_768) binary += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  return btoa(binary);
}

async function readReceipt(imageBase64: string, mimeType: string) {
  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Receipt scanning is not configured yet.');
  if (imageBase64.length < 20 || imageBase64.length > 14_000_000) throw new Error('Please choose a receipt image under 10 MB.');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [
        { inlineData: { mimeType, data: imageBase64 } },
        { text: 'Read this household receipt. Identify the merchant, final amount actually paid, receipt date, and best category. Ignore subtotals, savings, tax lines, cash tendered, and change. Use Other if uncertain. Return confidence from 0 to 1 for merchant, amount, and date.' },
      ] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT', required: ['merchant', 'total_amount', 'category', 'confidence'],
          properties: {
            merchant: { type: 'STRING' }, total_amount: { type: 'NUMBER' }, receipt_date: { type: 'STRING' },
            category: { type: 'STRING', enum: categories },
            confidence: { type: 'OBJECT', properties: { merchant: { type: 'NUMBER' }, amount: { type: 'NUMBER' }, date: { type: 'NUMBER' } } },
          },
        }, thinkingConfig: { thinkingLevel: 'low' },
      },
    }),
  });
  if (!response.ok) throw new Error('The OCR service could not read this receipt.');
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No receipt details were found.');
  const parsed = JSON.parse(text); const amount = Number(parsed.total_amount); const confidence = parsed.confidence ?? {};
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('The receipt total was unclear.');
  return {
    merchant: String(parsed.merchant || 'Receipt').slice(0, 100), total_amount: Math.round(amount * 100) / 100,
    receipt_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.receipt_date) ? parsed.receipt_date : null,
    category: categories.includes(parsed.category) ? parsed.category : 'Other',
    confidence: { merchant: Number(confidence.merchant) || 0, amount: Number(confidence.amount) || 0, date: Number(confidence.date) || 0 },
  };
}

async function processJob(jobId: string, imagePath: string) {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  try {
    await admin.from('receipt_scan_jobs').update({ status: 'processing', error_message: null }).eq('id', jobId);
    const download = await admin.storage.from('receipts').download(imagePath);
    if (download.error) throw download.error;
    const result = await readReceipt(bytesToBase64(new Uint8Array(await download.data.arrayBuffer())), download.data.type || 'image/jpeg');
    await admin.from('receipt_scan_jobs').update({ status: 'complete', result, processed_at: new Date().toISOString() }).eq('id', jobId);
  } catch (error) {
    await admin.from('receipt_scan_jobs').update({ status: 'failed', error_message: error instanceof Error ? error.message : 'Receipt scan failed', processed_at: new Date().toISOString() }).eq('id', jobId);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  const authorization = request.headers.get('Authorization');
  if (!authorization) return Response.json({ error: 'Sign in required' }, { status: 401, headers: corsHeaders });
  try {
    const body = await request.json() as { jobId?: string; imageBase64?: string; mimeType?: string };
    if (body.jobId) {
      const client = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
      const job = await client.from('receipt_scan_jobs').select('id,image_path,status').eq('id', body.jobId).single();
      if (job.error || !job.data) return Response.json({ error: 'Scan job not found' }, { status: 404, headers: corsHeaders });
      if (job.data.status === 'complete') return Response.json({ accepted: true, status: 'complete' }, { headers: corsHeaders });
      if (job.data.status === 'processing') return Response.json({ accepted: true, status: 'processing' }, { status: 202, headers: corsHeaders });
      const work = processJob(job.data.id, job.data.image_path);
      if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(work); else await work;
      return Response.json({ accepted: true, status: 'queued' }, { status: 202, headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
    }
    if (typeof body.imageBase64 !== 'string' || typeof body.mimeType !== 'string') throw new Error('A scan job is required.');
    return Response.json(await readReceipt(body.imageBase64, body.mimeType), { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Receipt scan failed.' }, { status: 400, headers: corsHeaders });
  }
});
