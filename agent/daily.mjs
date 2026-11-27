// Cloud daily job (GitHub Actions): keeps the Buffer queue filled a few days ahead without the Mac.
// TikTok: 2 videos/day at 13:00 and 19:00 MSK from the pre-hosted backlog (agent/backlog.json), published automatically.
// X: 1 text post/day; Claude picks the time (10:00–22:00 MSK). Titles, hashtags, X posts: ONE short `claude -p --model haiku` call
// that uses state/trends.json (refreshed twice a day by trends.mjs); called only when there is something to plan.
// Env: BUFFER_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, NOTIFY_BOT_TOKEN + NOTIFY_CHAT_ID (optional: warnings to Telegram).
// Usage: node agent/daily.mjs [--dry]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// claude CLI is installed only when it is actually needed (saves CI time on idle runs)
function claude(args, opts) {
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); }
  catch { execFileSync('npm', ['install', '-g', '--silent', '@anthropic-ai/claude-code'], { stdio: 'inherit' }); }
  return execFileSync('claude', args, opts);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const env = process.env;
const DAYS_AHEAD = 3;          // today + 3 days
const QUEUE_CAP = 10;          // Buffer free plan: max scheduled posts in the organisation
const TT_TIMES = ['13:00', '19:00'];
const X_WINDOW = ['10:00', '22:00'];  // Claude chooses inside this window
const X_FALLBACK = ['12:40', '13:20', '18:30', '19:45', '21:10'];
const MSK = '+03:00';
const read = (p, d) => (existsSync(resolve(ROOT, p)) ? JSON.parse(readFileSync(resolve(ROOT, p), 'utf8')) : d);
mkdirSync(resolve(ROOT, 'state'), { recursive: true });
const posted = { videos: [], ...read('state/posted.json', {}) };
const backlog = read('agent/backlog.json', []);
const trends = read('state/trends.json', null);

async function api(query, variables) {
  const r = await fetch('https://api.buffer.com', { method: 'POST',
    headers: { Authorization: `Bearer ${env.BUFFER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
}
async function notify(text) {
  if (!env.NOTIFY_BOT_TOKEN || !env.NOTIFY_CHAT_ID || dry) return;
  await fetch(`https://api.telegram.org/bot${env.NOTIFY_BOT_TOKEN}/sendMessage`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.NOTIFY_CHAT_ID, text }) });
}
const mskDay = (t) => new Date(t + 3 * 3600e3).toISOString().slice(0, 10);
const at = (day, hm) => new Date(`${day}T${hm}:00${MSK}`);

const org = (await api('{ account { organizations { id } } }')).account.organizations[0].id;
const channels = (await api(`{ channels(input:{organizationId:"${org}"}) { id service isDisconnected } }`)).channels;
const tiktok = channels.find((c) => c.service === 'tiktok' && !c.isDisconnected);
const x = channels.find((c) => c.service === 'twitter' && !c.isDisconnected);
const scheduled = (await api(`{ posts(input:{organizationId:"${org}", filter:{status:[scheduled]}}, first: 100) {
  edges { node { id channelId dueAt } } } }`)).posts.edges.map((e) => e.node);
let free = QUEUE_CAP - scheduled.length;
const perDay = (ch) => scheduled.filter((p) => p.channelId === ch?.id).reduce((m, p) => {
  const d = mskDay(Date.parse(p.dueAt)); m[d] = (m[d] || 0) + 1; return m; }, {});
const ttDays = perDay(tiktok), xDays = perDay(x);

// slots to fill, day by day, until the free-plan queue cap is reached
const now = Date.now();
const today = mskDay(now);
const slots = [];
for (let k = 0; k <= DAYS_AHEAD; k++) {
  const day = mskDay(now + k * 86400e3);
  if (tiktok) TT_TIMES.slice(ttDays[day] || 0).forEach((hm) => { if (at(day, hm) > now + 15 * 60e3) slots.push({ ch: 'tiktok', due: at(day, hm) }); });
  if (x && !xDays[day] && at(day, X_WINDOW[1]) > now + 60 * 60e3) slots.push({ ch: 'x', day });
}
const done = new Set(posted.videos);
const queue = backlog.filter((b) => !done.has(b.name));
const plan = [];
for (const s of slots) {
  if (free <= 0) break;
  if (s.ch === 'tiktok') { const v = queue.shift(); if (!v) continue; plan.push({ ...s, video: v }); }
  else plan.push(s);
  free--;
}
console.log(`today ${today}: scheduled ${scheduled.length}, planning ${plan.length} (tiktok ${plan.filter((p) => p.video).length}, x ${plan.filter((p) => !p.video).length})`);
if (!plan.length) process.exit(0);

// copy for all planned posts in one short Claude call
const tt = plan.filter((p) => p.video), xs = plan.filter((p) => !p.video);
const dow = (d) => ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][new Date(`${d}T12:00:00Z`).getUTCDay()];
const ask = `SMM бренда Emojii (Telegram Mini App @emojii_robot: анимированные эмодзи для статуса и подарков друзьям).
Верни ТОЛЬКО JSON без пояснений: {"tiktok":[{"title":"","text":""}],"x":[{"time":"HH:MM","text":""}]}
tiktok — ${tt.length} шт., ПО-РУССКИ, для роликов с текстом в кадре:
${tt.map((p, i) => `${i + 1}. ${p.video.overlay}`).join('\n') || '(нет)'}
 title: хук до 90 симв. (интрига/боль/«отметь того, кто…»/вопрос), не копируй текст кадра, 1–2 эмодзи;
 text: вопрос для комментов + 5–7 хэштегов (#рекомендации #юмор #мем #pov + #telegram #телеграм #эмодзи #статус), всегда #emojii.
x — ${xs.length} шт., НА АНГЛИЙСКОМ, для дней: ${xs.map((p) => `${p.day} (${dow(p.day)})`).join(', ') || '(нет)'}
 text: до 240 симв., смешная мысль про жизнь в Telegram, эмодзи-статусы, подарки эмодзи; стиль аккаунта Telegram в X: сухая ирония,
 строчные ок, без «!», эмодзи 0–1, 0–1 хэштег, без @ и ссылок, не про Дурова.
 time: время публикации по Москве ${X_WINDOW.join('–')}, когда этот пост лучше зайдёт (учти день недели и тон), не круглое.
${trends ? `Тренды (${trends.updated.slice(0, 10)}), используй где уместно: ${JSON.stringify({ ...trends, updated: undefined })}\n` : ''}Запрещено: деньги, цены, Stars, TON, заработок, инвестиции, «редкость = ценность», рандом, ставки, розыгрыши, школа, дети,
реальные люди и бренды, цитаты песен, обманный кликбейт.`;
const out = claude(['-p', ask, '--model', 'haiku', '--max-turns', '1', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
  { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'inherit'] });
const copy = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));

// X time from Claude, clamped to the window and at least 30 min from now; otherwise a random good slot
function xDue(day, hm) {
  const ok = (t) => t >= at(day, X_WINDOW[0]) && t <= at(day, X_WINDOW[1]) && t > now + 30 * 60e3;
  const t = /^\d{1,2}:\d{2}$/.test(hm || '') ? at(day, hm.padStart(5, '0')) : null;
  if (t && ok(t)) return t;
  const alt = X_FALLBACK.map((h) => at(day, h)).filter(ok);
  return alt[Math.floor(Math.random() * alt.length)] || new Date(now + 45 * 60e3);
}
let ti = 0, xi = 0;
const log = [];
for (const p of plan) {
  const input = p.video
    ? (() => { const c = (copy.tiktok || [])[ti++] || {}; return { channelId: tiktok.id, text: `${c.title || p.video.overlay}\n\n${c.text || '#emojii #telegram #эмодзи #pov'}`,
        assets: [{ video: { url: p.video.url, metadata: { thumbnailOffset: 2500 } } }] }; })()
    : (() => { const c = (copy.x || [])[xi++] || {}; p.due = xDue(p.day, c.time); return { channelId: x.id, text: typeof c === 'string' ? c : c.text, assets: [] }; })();
  if (!input.text) continue;
  const entry = { due: p.due.toISOString(), ch: p.ch, video: p.video?.name, text: input.text };
  if (!dry) {
    const r = await api(`mutation($i: CreatePostInput!) { createPost(input: $i) { ... on PostActionSuccess { post { id } } ... on MutationError { message } } }`,
      { i: { ...input, schedulingType: 'automatic', mode: 'customScheduled', dueAt: entry.due } });
    entry.id = r.createPost.post?.id; entry.error = r.createPost.message;
    if (entry.id && p.video) posted.videos.push(p.video.name);
  }
  log.push(entry);
  console.log(entry.due, entry.ch, entry.id || entry.error || '(dry)', entry.text.split('\n')[0]);
}
if (!dry) {
  writeFileSync(resolve(ROOT, 'state/posted.json'), JSON.stringify(posted, null, 2));
  const all = read('state/log.json', []); all.push({ run: new Date().toISOString(), posts: log });
  writeFileSync(resolve(ROOT, 'state/log.json'), JSON.stringify(all.slice(-60), null, 2));
}
const left = backlog.filter((b) => !posted.videos.includes(b.name)).length;
if (left <= 6) await notify(`⚠️ Emojii: готовых роликов для TikTok осталось ${left}. Откройте Mac — агент отрендерит новые (agent/ctl.sh run).`);
const errors = log.filter((e) => e.error);
if (errors.length) await notify(`⚠️ Emojii: Buffer не принял ${errors.length} пост(а): ${errors[0].error}`);
