// Watches public Telegram channels (Durov, Telegram) and sends reply drafts for X to your phone via a Telegram bot.
// A human posts the reply (X forbids automated replies to accounts that didn't ask for them).
// Usage: node agent/watch.mjs [--dry]   (GitHub Actions runs it every hour: .github/workflows/watch.yml)
// Env (agent/.env): NOTIFY_BOT_TOKEN — a NEW bot from @BotFather; NOTIFY_CHAT_ID is optional (found via /start).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const CHANNELS = [{ tg: 'durov', x: 'durov' }, { tg: 'telegram', x: 'telegram' }];
const MAX_AGE_H = 12; // older posts are no longer worth an early reply
mkdirSync(resolve(HERE, 'state'), { recursive: true });
const statePath = resolve(HERE, 'state/watch.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { seen: {} };
const env = process.env;
const decode = (s) => s.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function posts(ch) {
  const html = await (await fetch(`https://t.me/s/${ch}`, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  return html.split('class="tgme_widget_message_wrap').slice(1).map((b) => ({
    id: Number(b.match(/data-post="[^/]+\/(\d+)"/)?.[1]),
    at: b.match(/<time datetime="([^"]+)"/)?.[1],
    text: decode(b.match(/js-message_text[^>]*>([\s\S]*?)<\/div>/)?.[1] || ''),
  })).filter((p) => p.id);
}

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.NOTIFY_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return r.json();
}

async function chatId() {
  if (env.NOTIFY_CHAT_ID) return env.NOTIFY_CHAT_ID;
  if (state.chatId) return state.chatId;
  const u = await tg('getUpdates');
  const id = u.result?.reverse().find((x) => x.message?.text?.startsWith('/start'))?.message.chat.id;
  if (id) { state.chatId = id; await tg('sendMessage', { chat_id: id, text: 'Готово: сюда будут приходить черновики ответов для X.' }); }
  return id;
}

function drafts(ch, post) {
  const prompt = `Ты ведёшь X (Twitter) бренда Emojii — Telegram Mini App @emojii_robot с анимированными эмодзи
для статуса профиля и подарков друзьям. Вот свежий пост @${ch}:
"""${post.text.slice(0, 700)}"""
Дай 3 варианта ответа под этот пост, по одному на строку, без нумерации и кавычек. Язык — всегда английский.
Стиль — как у самого аккаунта Telegram в X: коротко (до 140 символов), сухая ирония, молодёжно, мемно, интернет-сленг,
можно строчными буквами, без восклицательных знаков. Эмодзи — 0, максимум 1 и только если он и есть шутка.
Это шутка-реплика в треде, а не реклама: без ссылок, «скачайте/попробуйте», хэштегов, лести и троллинга.
Три варианта должны быть разными по механике шутки (например: наблюдение, абсурд, самоирония).
Никаких цен, доходности, «вырастет в цене», торговли, инвестиций, ставок, рандома и розыгрышей — даже если пост про это;
в таком случае шути про сам Telegram, эмодзи или статусы. Если пост не даёт повода для уместного ответа — выведи только слово SKIP.`;
  try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); } // install the CLI only when a new post needs drafts
  catch { execFileSync('npm', ['install', '-g', '--silent', '@anthropic-ai/claude-code'], { stdio: 'inherit' }); }
  const out = execFileSync('claude', ['-p', prompt, '--model', 'haiku', '--max-turns', '1', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { cwd: HERE, encoding: 'utf8', timeout: 180000 }).trim();
  return out === 'SKIP' ? [] : out.split('\n').map((s) => s.trim().replace(/^["«]|["»]$/g, '')).filter(Boolean).slice(0, 3);
}

// Best effort: find the same post on X (public embed timeline) to open the reply composer directly.
// That endpoint is often rate-limited; without the id the buttons copy the text instead.
async function xPostId(handle, post) {
  try {
    const html = await (await fetch(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const data = JSON.parse(html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)[1]);
    const norm = (t) => t.toLowerCase().replace(/https?:\S+/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 40);
    const want = norm(post.text);
    const hit = data.props.pageProps.timeline.entries.map((e) => e.content?.tweet).filter(Boolean)
      .find((t) => norm(t.full_text || t.text || '').startsWith(want.slice(0, 25)));
    return hit?.id_str || null;
  } catch { return null; }
}

const id = dry ? 'dry' : await chatId();
if (!id) { console.log('Нет chat id: напишите своему боту /start и запустите снова.'); process.exit(0); }
for (const c of CHANNELS) {
  const list = await posts(c.tg);
  const last = state.seen[c.tg];
  if (last === undefined) { state.seen[c.tg] = Math.max(...list.map((p) => p.id)); continue; } // first run: just remember
  for (const p of list.filter((p) => p.id > last)) {
    state.seen[c.tg] = Math.max(state.seen[c.tg], p.id);
    if (!p.text || Date.now() - Date.parse(p.at) > MAX_AGE_H * 3600e3) continue;
    const d = drafts(c.tg, p);
    console.log(`${c.tg}/${p.id}: ${d.length} drafts`);
    if (!d.length || dry) { d.forEach((x) => console.log('  ', x)); continue; }
    const xid = await xPostId(c.x, p);
    // reply buttons open X's composer already replying to the post; otherwise one tap copies the text
    const rows = d.map((x, i) => [xid
      ? { text: `↩️ Ответить: вариант ${i + 1}`, url: `https://x.com/intent/post?in_reply_to=${xid}&text=${encodeURIComponent(x)}` }
      : { text: `📋 Скопировать вариант ${i + 1}`, copy_text: { text: x } }]);
    rows.push([{ text: `Открыть ${xid ? 'пост' : '@' + c.x} в X`, url: xid ? `https://x.com/${c.x}/status/${xid}` : `https://x.com/${c.x}` }]);
    const sent = await tg('sendMessage', { chat_id: id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `🆕 <b>@${c.x}</b>: ${esc(p.text.slice(0, 300))}${p.text.length > 300 ? '…' : ''}\n\n` +
        d.map((x, i) => `<b>${i + 1}.</b> ${esc(x)}`).join('\n\n') +
        (xid ? '' : '\n\n<i>Пост в X не нашёлся автоматически: скопируй вариант, открой профиль и ответь под постом.</i>'),
      reply_markup: { inline_keyboard: rows } });
    console.log(`  telegram: ${sent.ok ? 'sent' : sent.description} (x post id: ${xid || 'not found'})`);
  }
}
if (!dry) writeFileSync(statePath, JSON.stringify(state, null, 2));
