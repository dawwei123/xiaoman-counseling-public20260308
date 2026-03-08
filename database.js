import { createClient } from '@supabase/supabase-js';

let supabase;

function getClient() {
  if (!supabase) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
    console.log('SUPABASE_URL:', supabaseUrl ? '有值' : '沒有值');
    console.log('SUPABASE_KEY:', supabaseKey ? '有值' : '沒有值');
    if (!supabaseUrl) throw new Error('SUPABASE_URL is not set');
    if (!supabaseKey) throw new Error('SUPABASE_KEY is not set');
    supabase = createClient(supabaseUrl, supabaseKey);
  }
  return supabase;
}

export async function getAllSettings() {
  const { data, error } = await getClient().from('settings').select('key, value');
  if (error) throw error;
  return Object.fromEntries(data.map(r => [r.key, r.value]));
}

export async function updateSettings(obj) {
  const allowed = ['site_name','badge','intro_title','intro_body','system_prompt','footer_text','model','max_tokens','opening_messages'];
  const rows = Object.entries(obj).filter(([k]) => allowed.includes(k)).map(([key, value]) => ({ key, value: String(value) }));
  if (!rows.length) return;
  const { error } = await getClient().from('settings').upsert(rows, { onConflict: 'key' });
  if (error) throw error;
}

export async function upsertSession(sessionId, ip) {
  const { error } = await getClient().from('sessions').upsert({ session_id: sessionId, ip, updated_at: new Date().toISOString() }, { onConflict: 'session_id' });
  if (error) throw error;
}

export async function saveMessage(sessionId, role, content, tokens = 0) {
  const { error } = await getClient().from('messages').insert({ session_id: sessionId, role, content, tokens });
  if (error) throw error;
}

export async function getSessionMessages(sessionId, limit = 40) {
  const { data, error } = await getClient().from('messages').select('role, content').eq('session_id', sessionId).order('created_at', { ascending: true }).limit(limit);
  if (error) throw error;
  return data;
}

export async function getHistory({ page = 1, pageSize = 20 } = {}) {
  const from = (page - 1) * pageSize;
  const { data, error, count } = await getClient().from('sessions').select('session_id, ip, created_at, updated_at, messages(count)', { count: 'exact' }).order('updated_at', { ascending: false }).range(from, from + pageSize - 1);
  if (error) throw error;
  return { total: count ?? 0, page, pageSize, sessions: (data || []).map(s => ({ ...s, msg_count: s.messages?.[0]?.count ?? 0 })) };
}

export async function getSessionDetail(sessionId) {
  const { data, error } = await getClient().from('messages').select('role, content, created_at').eq('session_id', sessionId).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

export async function updateDailyStats({ sessions = 0, userMessages = 0, aiMessages = 0, tokens = 0, downloads = 0 } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await getClient().from('daily_stats').select('*').eq('date', today).single();
  const row = {
    date: today,
    sessions: (existing?.sessions || 0) + sessions,
    user_messages: (existing?.user_messages || 0) + userMessages,
    ai_messages: (existing?.ai_messages || 0) + aiMessages,
    total_tokens: (existing?.total_tokens || 0) + tokens,
    downloads: (existing?.downloads || 0) + downloads,
  };
  await getClient().from('daily_stats').upsert(row, { onConflict: 'date' });
}

export async function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const [{ data: allRows }, { data: todayRow }, { data: recentDays }] = await Promise.all([
    getClient().from('daily_stats').select('sessions, user_messages, ai_messages, total_tokens'),
    getClient().from('daily_stats').select('*').eq('date', today).single(),
    getClient().from('daily_stats').select('*').order('date', { ascending: false }).limit(7),
  ]);
  const totals = (allRows || []).reduce((acc, r) => ({
    total_sessions: acc.total_sessions + (r.sessions || 0),
    total_user_messages: acc.total_user_messages + (r.user_messages || 0),
    total_ai_messages: acc.total_ai_messages + (r.ai_messages || 0),
    total_tokens: acc.total_tokens + (r.total_tokens || 0),
  }), { total_sessions: 0, total_user_messages: 0, total_ai_messages: 0, total_tokens: 0 });
  return { totals, today: todayRow || {}, recentDays: (recentDays || []).reverse() };
}