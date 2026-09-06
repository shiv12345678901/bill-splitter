const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

declare const Deno: {
  env: { get: (name: string) => string | undefined };
  serve: (handler: (request: Request) => Response | Promise<Response>) => void;
};

const categories = ['Groceries', 'Utilities', 'Household', 'Dining', 'Other'];

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  if (!request.headers.get('Authorization')) return Response.json({ error: 'Sign in required' }, { status: 401, headers: corsHeaders });

  try {
    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) throw new Error('Receipt scanning is not configured yet.');
    const { imageBase64, mimeType } = await request.json() as { imageBase64?: string; mimeType?: string };
    if (typeof imageBase64 !== 'string' || imageBase64.length < 20 || imageBase64.length > 14_000_000) throw new Error('Please choose a receipt image under 10 MB.');
    if (typeof mimeType !== 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new Error('Please choose a JPG, PNG, or WebP image.');

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: 'Read this household receipt. Identify the merchant, final amount actually paid, receipt date, and best category. Ignore subtotals, savings, tax lines, cash tendered, and change. Use Other if uncertain. Return an empty receipt date when it is unclear.' },
        ] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['merchant', 'total_amount', 'category'],
            properties: {
              merchant: { type: 'STRING', description: 'Store, restaurant, or utility name; Receipt if unreadable' },
              total_amount: { type: 'NUMBER', description: 'Final numerical amount paid' },
              receipt_date: { type: 'STRING', description: 'Receipt date in YYYY-MM-DD format, or an empty string if unclear' },
              category: { type: 'STRING', enum: categories },
            },
          },
          thinkingConfig: { thinkingLevel: 'low' },
        },
      }),
    });
    if (!response.ok) throw new Error('The OCR service could not read this receipt.');
    const result = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No receipt details were found.');
    const parsed = JSON.parse(text);
    const amount = Number(parsed.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('The receipt total was unclear.');

    return Response.json({
      merchant: String(parsed.merchant || 'Receipt').slice(0, 100),
      total_amount: Math.round(amount * 100) / 100,
      receipt_date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.receipt_date) ? parsed.receipt_date : null,
      category: categories.includes(parsed.category) ? parsed.category : 'Other',
    }, { headers: { ...corsHeaders, 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Receipt scan failed.' }, { status: 400, headers: corsHeaders });
  }
});
