import { env } from 'cloudflare:workers';

const allowedMembers = new Set(['Alex', 'Sam', 'Jordan', 'Taylor']);
const allowedCategories = new Set(['Groceries', 'Utilities', 'Household', 'Dining', 'Other']);

function rowToExpense(row: Record<string, unknown>) {
  const createdAt = new Date(Number(row.created_at) * 1000);
  return {
    id: String(row.id),
    merchant: String(row.merchant),
    amount: Number(row.amount),
    category: String(row.category),
    payer: String(row.payer),
    date: createdAt.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }),
    image: row.image_key ? `/api/files/${encodeURIComponent(String(row.image_key))}` : undefined,
  };
}

export async function GET() {
  try {
    const result = await env.DB.prepare('select * from expenses where settled = 0 order by created_at desc limit 100').all();
    return Response.json({ expenses: result.results.map((row) => rowToExpense(row as Record<string, unknown>)) });
  } catch {
    return Response.json({ expenses: null }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const form = await request.formData();
  const merchant = String(form.get('merchant') ?? '').trim();
  const payer = String(form.get('payer') ?? '');
  const category = String(form.get('category') ?? 'Other');
  const amount = Number(form.get('amount'));
  if (!merchant || !allowedMembers.has(payer) || !allowedCategories.has(category) || !Number.isFinite(amount) || amount <= 0) {
    return Response.json({ error: 'Invalid receipt details.' }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const image = form.get('image');
  let imageKey: string | null = null;
  if (image instanceof File && image.size > 0) {
    imageKey = `${id}-${image.name.replace(/[^a-zA-Z0-9._-]/g, '-')}`;
    await env.FILES.put(imageKey, image.stream(), { httpMetadata: { contentType: image.type || 'application/octet-stream' } });
  }
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('insert into expenses (id, created_at, payer, merchant, amount, category, image_key, settled) values (?, ?, ?, ?, ?, ?, ?, 0)')
    .bind(id, now, payer, merchant, amount, category, imageKey)
    .run();
  return Response.json({ expense: rowToExpense({ id, created_at: now, payer, merchant, amount, category, image_key: imageKey }) }, { status: 201 });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'Missing receipt id.' }, { status: 400 });
  const row = await env.DB.prepare('select image_key from expenses where id = ?').bind(id).first<{ image_key: string | null }>();
  await env.DB.prepare('delete from expenses where id = ?').bind(id).run();
  if (row?.image_key) await env.FILES.delete(row.image_key);
  return Response.json({ ok: true });
}

export async function PATCH() {
  await env.DB.prepare('update expenses set settled = 1 where settled = 0').run();
  return Response.json({ ok: true });
}
