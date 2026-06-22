// api/auth.js  —  Vercel serverless function
// Handles: /api/auth?action=signup|join|login|validate|me|partner
//
// Deploy to Vercel (free tier is fine).
// Set these environment variables in Vercel dashboard:
//   SUPA_URL         = https://xxxx.supabase.co
//   SUPA_SERVICE_KEY = your service_role key  (NOT anon key — gives full DB access)

const SUPA_URL         = process.env.SUPA_URL;
const SUPA_SERVICE_KEY = process.env.SUPA_SERVICE_KEY;

// ── Supabase REST helper ──────────────────────────────────────────────────────
async function supa(method, path, body) {
  const res = await fetch(`${SUPA_URL}/rest/v1${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SUPA_SERVICE_KEY,
      'Authorization': `Bearer ${SUPA_SERVICE_KEY}`,
      'Prefer':        method === 'POST' ? 'return=representation,resolution=merge-duplicates' : 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ── Simple password hashing (bcrypt-lite via Web Crypto) ─────────────────────
// For production swap with bcrypt npm package.
async function hashPassword(plain) {
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.digest('SHA-256', enc.encode(plain + 'jbu_salt_2025'));
  return Array.from(new Uint8Array(key)).map(b => b.toString(16).padStart(2,'0')).join('');
}

function generateToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2,'0')).join('');
}

function json(res, data, status = 200) {
  res.status(status).json(data);
}

function err(res, msg, status = 400) {
  res.status(status).json({ error: msg });
}

// ── Main handler ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);
  const body   = req.method === 'POST' ? req.body : req.query;

  try {
    if (action === 'signup')   return await doSignup(req, res, body);
    if (action === 'join')     return await doJoin(req, res, body);
    if (action === 'login')    return await doLogin(req, res, body);
    if (action === 'validate') return await doValidate(req, res);
    if (action === 'me')       return await doMe(req, res);
    if (action === 'partner')  return await doPartner(req, res);
    return err(res, 'Unknown action', 404);
  } catch (e) {
    console.error('[auth]', e);
    return err(res, 'Server error', 500);
  }
};

// ── /api/auth?action=signup ───────────────────────────────────────────────────
// Body: { email, password, display_name, city }
// Creates user (person1) + couple + invite_code
async function doSignup(req, res, body) {
  const { email, password, display_name, city } = body;
  if (!email || !password || !display_name)
    return err(res, 'email, password and display_name are required');

  // Check email not already used
  const existing = await supa('GET', `/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id`);
  if (existing.data && existing.data.length > 0)
    return err(res, 'An account with this email already exists');

  const pw_hash    = await hashPassword(password);
  const invite_code = await generateInviteCode();

  // 1. Insert user (no couple_id yet)
  const userRes = await supa('POST', '/users', {
    email:        email.toLowerCase().trim(),
    password_hash: pw_hash,
    display_name: display_name.trim(),
    city:         (city || '').trim(),
    role:         'person1',
    invite_code,
    invite_used:  false,
  });
  if (!userRes.ok || !userRes.data || !userRes.data[0])
    return err(res, 'Could not create account: ' + JSON.stringify(userRes.data));

  const user = userRes.data[0];

  // 2. Create couple
  const coupleRes = await supa('POST', '/couples', { person1_id: user.id });
  if (!coupleRes.ok || !coupleRes.data || !coupleRes.data[0])
    return err(res, 'Could not create couple');

  const couple = coupleRes.data[0];

  // 3. Link user → couple
  await supa('PATCH', `/users?id=eq.${user.id}`, { couple_id: couple.id });

  // 4. Create session
  const token = generateToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
  await supa('POST', '/sessions', { user_id: user.id, token, expires_at: expires });

  return json(res, {
    token,
    user: {
      id:           user.id,
      email:        user.email,
      display_name: user.display_name,
      city:         user.city,
      role:         'person1',
      couple_id:    couple.id,
      avatar_b64:   user.avatar_b64 || null,
    },
    invite_code,
    couple_id: couple.id,
    is_new:    true,
  });
}

// ── /api/auth?action=join ─────────────────────────────────────────────────────
// Body: { email, password, display_name, city, invite_code }
async function doJoin(req, res, body) {
  const { email, password, display_name, city, invite_code } = body;
  if (!email || !password || !display_name || !invite_code)
    return err(res, 'email, password, display_name and invite_code are required');

  // Find person1 by invite code
  const invRes = await supa('GET', `/users?invite_code=eq.${encodeURIComponent(invite_code.toUpperCase())}&invite_used=eq.false&select=*`);
  if (!invRes.data || !invRes.data[0])
    return err(res, 'Invalid or already used invite code');

  const person1 = invRes.data[0];

  // Check email not already used
  const existing = await supa('GET', `/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id`);
  if (existing.data && existing.data.length > 0)
    return err(res, 'An account with this email already exists');

  const pw_hash = await hashPassword(password);

  // 1. Create person2 user
  const userRes = await supa('POST', '/users', {
    email:         email.toLowerCase().trim(),
    password_hash: pw_hash,
    display_name:  display_name.trim(),
    city:          (city || '').trim(),
    role:          'person2',
    couple_id:     person1.couple_id,
    invite_used:   false,
  });
  if (!userRes.ok || !userRes.data || !userRes.data[0])
    return err(res, 'Could not create account');

  const user = userRes.data[0];

  // 2. Update couple with person2_id
  await supa('PATCH', `/couples?id=eq.${person1.couple_id}`, { person2_id: user.id });

  // 3. Mark invite used on person1
  await supa('PATCH', `/users?id=eq.${person1.id}`, { invite_used: true });

  // 4. Create session
  const token = generateToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supa('POST', '/sessions', { user_id: user.id, token, expires_at: expires });

  return json(res, {
    token,
    user: {
      id:           user.id,
      email:        user.email,
      display_name: user.display_name,
      city:         user.city,
      role:         'person2',
      couple_id:    person1.couple_id,
      avatar_b64:   null,
    },
    couple_id: person1.couple_id,
    is_new:    true,
  });
}

// ── /api/auth?action=login ────────────────────────────────────────────────────
// Body: { email, password }
async function doLogin(req, res, body) {
  const { email, password } = body;
  if (!email || !password) return err(res, 'email and password are required');

  const userRes = await supa('GET', `/users?email=eq.${encodeURIComponent(email.toLowerCase())}&select=*`);
  if (!userRes.data || !userRes.data[0]) return err(res, 'Incorrect email or password');

  const user    = userRes.data[0];
  const pw_hash = await hashPassword(password);
  if (pw_hash !== user.password_hash) return err(res, 'Incorrect email or password');
  if (!user.couple_id) return err(res, 'Your account is not linked to a couple yet');

  // Delete old sessions for this user, create fresh one
  await supa('DELETE', `/sessions?user_id=eq.${user.id}`);
  const token   = generateToken();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await supa('POST', '/sessions', { user_id: user.id, token, expires_at: expires });

  return json(res, {
    token,
    user: {
      id:           user.id,
      email:        user.email,
      display_name: user.display_name,
      city:         user.city,
      role:         user.role,
      couple_id:    user.couple_id,
      avatar_b64:   user.avatar_b64 || null,
    },
    couple_id: user.couple_id,
  });
}

// ── /api/auth?action=validate ─────────────────────────────────────────────────
// Header: Authorization: Bearer <token>
async function doValidate(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return err(res, 'Invalid or expired session', 401);
  return json(res, { valid: true, user });
}

// ── /api/auth?action=me ───────────────────────────────────────────────────────
// Update display_name, city, avatar_b64 for current user
async function doMe(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return err(res, 'Unauthorized', 401);

  const body   = req.body || {};
  const update = {};
  if (body.display_name !== undefined) update.display_name = body.display_name.trim();
  if (body.city         !== undefined) update.city         = body.city.trim();
  if (body.avatar_b64   !== undefined) update.avatar_b64   = body.avatar_b64;

  if (Object.keys(update).length) {
    await supa('PATCH', `/users?id=eq.${user.id}`, update);
  }

  const fresh = await supa('GET', `/users?id=eq.${user.id}&select=id,email,display_name,city,role,couple_id,avatar_b64`);
  const u = fresh.data && fresh.data[0];
  return json(res, { user: u });
}

// ── /api/auth?action=partner ──────────────────────────────────────────────────
// Returns the other user in the couple
async function doPartner(req, res) {
  const user = await getUserFromRequest(req);
  if (!user) return err(res, 'Unauthorized', 401);

  const couple = await supa('GET', `/couples?id=eq.${user.couple_id}&select=person1_id,person2_id`);
  if (!couple.data || !couple.data[0]) return json(res, { partner: null });

  const c         = couple.data[0];
  const partnerId = c.person1_id === user.id ? c.person2_id : c.person1_id;
  if (!partnerId) return json(res, { partner: null });

  const partnerRes = await supa('GET', `/users?id=eq.${partnerId}&select=id,display_name,city,role,avatar_b64`);
  const partner    = partnerRes.data && partnerRes.data[0];
  return json(res, { partner: partner || null });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getUserFromRequest(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;

  const sessRes = await supa('GET', `/sessions?token=eq.${token}&select=user_id,expires_at`);
  if (!sessRes.data || !sessRes.data[0]) return null;
  const sess = sessRes.data[0];
  if (new Date(sess.expires_at) < new Date()) return null;

  const userRes = await supa('GET', `/users?id=eq.${sess.user_id}&select=id,email,display_name,city,role,couple_id,avatar_b64`);
  return userRes.data && userRes.data[0] || null;
}

async function generateInviteCode() {
  // Call Postgres function
  const r = await supa('GET', `/rpc/generate_invite_code`);
  if (r.ok && typeof r.data === 'string') return r.data.replace(/"/g,'');
  // Fallback
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
