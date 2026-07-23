// Pull your own 小红书 profile + every posted note with full public stats.
//
// Feeds two things: the dashboard's "My Content" view, and /bootstrap-voice
// (your top posts are the raw material for the voice guide).
//
// Public stats only: likes, saves, comments, shares. 完播率 / 曝光 / view counts
// are owner-private (创作者中心, needs your login) and this API cannot see them —
// view_count comes back 0. That's a platform limit, not a bug.
//
// Usage: node scripts/xhs_me.mjs <user_id_or_red_id> ["handle for search"]
//   node scripts/xhs_me.mjs <user_id>
//   node scripts/xhs_me.mjs <red_id> "<handle>"   # resolves red_id via search

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ENV = process.env.TIKHUB_ENV_PATH || path.resolve(root, '../wdyt/.env.local');
let KEY = process.env.TIKHUB_API_KEY;
if (!KEY && fs.existsSync(ENV)) KEY = fs.readFileSync(ENV, 'utf8').match(/^TIKHUB_API_KEY=(.*)$/m)?.[1];
if (!KEY) { console.error('No TIKHUB_API_KEY'); process.exit(1); }
KEY = KEY.trim().replace(/^["']|["']$/g, '');

const BASE = 'https://api.tikhub.io';
const H = { Authorization: `Bearer ${KEY}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const arg = process.argv[2];
const handle = process.argv[3];
if (!arg) { console.error('Usage: node scripts/xhs_me.mjs <user_id|red_id> [handle]'); process.exit(1); }

const num = (o, ...ks) => {
  for (const k of ks) {
    const v = o?.[k];
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && /^[\d.]+$/.test(v)) return +v;
  }
  return 0;
};
const cleanAvatar = u => (u || '').split('?')[0];

// A red_id (short numeric display id) must be resolved to the internal hash.
async function resolveId(id, name) {
  if (/^[0-9a-f]{24}$/i.test(id)) return id;
  if (!name) { console.error(`"${id}" looks like a red_id — pass your handle as the 2nd arg to resolve it.`); process.exit(1); }
  const r = await fetch(`${BASE}/api/v1/xiaohongshu/app_v2/search_users?keyword=${encodeURIComponent(name)}&page=1`, { headers: H });
  const j = await r.json();
  // search_users nests inconsistently too: users at data.users or data.data.users
  const users = j?.data?.users || j?.data?.data?.users || [];
  const hit = users.find(u => String(u.red_id) === String(id));
  if (!hit) { console.error(`No user with red_id ${id} found searching "${name}".`); process.exit(1); }
  console.log(`Resolved red_id ${id} → ${hit.id}`);
  return hit.id;
}

const userId = await resolveId(arg, handle);

// Profile. The API wraps this inconsistently — sometimes the payload is at
// data, sometimes nested one deeper at data.data. Unwrap whichever has the fields.
const pr = await fetch(`${BASE}/api/v1/xiaohongshu/app_v2/get_user_info?user_id=${userId}`, { headers: H });
const praw = (await pr.json())?.data || {};
const pj = (praw && typeof praw.liked === 'undefined' && praw.data && typeof praw.data === 'object')
  ? praw.data : praw;
const profile = {
  userId,
  redId: arg.match(/^\d+$/) ? arg : (pj.red_id || ''),
  name: pj.share_info?.title || handle || '',
  desc: (pj.desc || '').trim(),
  location: pj.ip_location || pj.location || '',
  avatar: cleanAvatar(pj.imageb || pj.images),
  banner: pj.banner_info?.image || '',
  likesRecv: num(pj, 'liked'),
  savesRecv: num(pj, 'collected'),
  follows: num(pj, 'follows'),
  fans: num(pj, 'fans'),
  shareLink: pj.share_link || `https://www.xiaohongshu.com/user/profile/${userId}`,
};

// All notes, cursor-paginated
const notes = [];
let cursor = '', page = 0;
while (page < 30) {
  const url = `${BASE}/api/v1/xiaohongshu/app_v2/get_user_posted_notes?user_id=${userId}${cursor ? `&cursor=${cursor}` : ''}`;
  const r = await fetch(url, { headers: H });
  if (!r.ok) { console.error(`page ${page + 1}: HTTP ${r.status}`); break; }
  const inner = (await r.json())?.data?.data || {};
  const batch = inner.notes || [];
  for (const n of batch) {
    const likes = num(n, 'likes', 'liked_count', 'nice_count');
    const saves = num(n, 'collected_count', 'infavs');
    notes.push({
      id: n.id,
      title: (n.display_title || n.title || '').trim() || '(untitled)',
      desc: (n.desc || '').replace(/\s+/g, ' ').trim(),
      type: n.type || 'normal',
      created: (n.create_time || 0) * (String(n.create_time).length <= 10 ? 1000 : 1),
      likes, saves,
      comments: num(n, 'comments_count'),
      shares: num(n, 'share_count'),
      cover: cleanAvatar(n.images_list?.[0]?.url || n.images_list?.[0]?.url_size_large || ''),
      url: `https://www.xiaohongshu.com/explore/${n.id}`,
    });
  }
  page++;
  console.log(`  page ${page}: +${batch.length} (total ${notes.length})`);
  if (!inner.has_more || !batch.length) break;
  cursor = batch[batch.length - 1]?.cursor || '';
  if (!cursor) break;
  await sleep(1500);
}

fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
fs.writeFileSync(path.join(root, 'me.json'), JSON.stringify({ profile, notes }, null, 1));
console.log(`\nWrote me.json — ${profile.name}: ${notes.length} notes, ${profile.follows} following, ${profile.likesRecv + profile.savesRecv} total interactions received`);
