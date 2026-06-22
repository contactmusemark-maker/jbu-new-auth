// api/notify.js  —  Vercel serverless function
// POST /api/notify
// Sends a push notification to the PARTNER of the authenticated user.
// Uses OneSignal External User IDs scoped to each user (user.id from Supabase).
//
// Environment variables needed in Vercel:
//   ONESIGNAL_APP_ID      = your OneSignal App ID
//   ONESIGNAL_API_KEY     = your OneSignal REST API key  (Settings → Keys & IDs)
//   SUPA_URL              = https://xxxx.supabase.co
//   SUPA_SERVICE_KEY      = your Supabase service_role key

const OS_APP_ID  = process.env.ONESIGNAL_APP_ID;
const OS_API_KEY = process.env.ONESIGNAL_API_KEY;
const SUPA_URL   = process.env.SUPA_URL;
const SUPA_KEY   = process.env.SUPA_SERVICE_KEY;

// ── Supabase REST helper ──────────────────────────────────────────────────────
async function supa(path) {
  const res = await fetch(`${SUPA_URL}/rest/v1${path}`, {
    headers: {
      apikey:        SUPA_KEY,
      Authorization: `Bearer ${SUPA_KEY}`,
    },
  });
  return res.ok ? res.json() : null;
}

// ── Validate session token → return user ─────────────────────────────────────
async function getUserFromToken(token) {
  if (!token) return null;
  const rows = await supa(`/sessions?token=eq.${token}&select=user_id,expires_at`);
  if (!rows || !rows[0]) return null;
  if (new Date(rows[0].expires_at) < new Date()) return null;
  const users = await supa(`/users?id=eq.${rows[0].user_id}&select=id,display_name,couple_id,role`);
  return users && users[0] ? users[0] : null;
}

// ── Get partner user_id ───────────────────────────────────────────────────────
async function getPartner(user) {
  const couples = await supa(`/couples?id=eq.${user.couple_id}&select=person1_id,person2_id`);
  if (!couples || !couples[0]) return null;
  const c = couples[0];
  const partnerId = c.person1_id === user.id ? c.person2_id : c.person1_id;
  if (!partnerId) return null;
  const partners = await supa(`/users?id=eq.${partnerId}&select=id,display_name`);
  return partners && partners[0] ? partners[0] : null;
}

// ── Notification content by type ──────────────────────────────────────────────
function buildNotification(type, senderName, message) {
  const templates = {
    chat:      { title: `${senderName} 💬`,      body: message || 'Sent you a message' },
    voice:     { title: `${senderName} 🎤`,      body: message || 'Sent you a voice message' },
    secret:    { title: `${senderName} 🔒`,      body: message || 'Left you a secret message' },
    lovenote:  { title: `${senderName} 💌`,      body: message || 'Left you a love note' },
    memory:    { title: `${senderName} 📸`,      body: message || 'Added a new memory' },
    movie:     { title: `${senderName} 🎬`,      body: message || 'Added a movie to our list' },
    wish:      { title: `${senderName} 🌟`,      body: message || 'Added to our bucket list' },
    mood:      { title: `${senderName} 😊`,      body: message || 'Updated their mood' },
    status:    { title: `${senderName} 💬`,      body: message || 'Updated their status' },
    tod:       { title: `${senderName} 🎲`,      body: message || 'Sent you a Truth or Dare' },
    tot:       { title: `${senderName} 💭`,      body: message || 'Sent you a This or That' },
    quiz:      { title: `${senderName} 💞`,      body: message || 'Sent you a Compatibility Quiz' },
    location:  { title: `${senderName} 🚗`,      body: message || 'Is on their way!' },
    missyou:   { title: `${senderName} 💗`,      body: message || 'Misses you right now' },
    perm:      { title: `${senderName} 🔐`,      body: message || 'Is asking for permission' },
    promise:   { title: `${senderName} 🤝`,      body: message || 'Made you a promise' },
    sticker:   { title: `${senderName} 🩷`,      body: message || 'Sent you a sticker' },
  };
  return templates[type] || { title: `${senderName} 💕`, body: message || 'Something new for you' };
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  try {
    const auth  = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
    const body  = req.body || {};
    const { type, message } = body;

    // 1. Authenticate sender
    const sender = await getUserFromToken(auth);
    if (!sender) return res.status(401).json({ error: 'Unauthorized' });

    // 2. Find partner
    const partner = await getPartner(sender);
    if (!partner) return res.status(200).json({ ok: true, skipped: 'no_partner' });

    // 3. Build notification
    const notif = buildNotification(type || 'chat', sender.display_name, message);

    // 4. Send via OneSignal REST API → target by external_id (partner's Supabase user.id)
    const osPayload = {
      app_id:                     OS_APP_ID,
      target_channel:             'push',
      include_aliases:            { external_id: [partner.id] },
      headings:                   { en: notif.title },
      contents:                   { en: notif.body },
      // Deep-link back into the right tab
      url:                        'https://justbetweenus.app/#' + (type || 'chat'),
      // Android config
      android_channel_id:         'jbu-default',
      android_visibility:         1,
      // iOS config
      ios_sound:                  'notification.wav',
      // Collapse duplicate rapid-fire notifs of same type
      collapse_id:                `jbu-${sender.couple_id}-${type}`,
      // Small data payload the app can read on open
      data: {
        type:      type || 'chat',
        couple_id: sender.couple_id,
        from:      sender.id,
        from_name: sender.display_name,
      },
    };

    const osRes = await fetch('https://onesignal.com/api/v1/notifications', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${OS_API_KEY}`,
      },
      body: JSON.stringify(osPayload),
    });

    const osData = await osRes.json();

    if (!osRes.ok) {
      console.error('[notify] OneSignal error:', osData);
      return res.status(200).json({ ok: false, os_error: osData });
    }

    return res.status(200).json({ ok: true, notification_id: osData.id });
  } catch (e) {
    console.error('[notify] error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
