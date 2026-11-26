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
  const prompt = `Ты пишешь ответы в X (Twitter) от лица бренда Emojii — Telegram Mini App @emojii_robot с анимированными эмодзи
для статуса профиля и подарков друзьям. Вот свежий пост @${ch}:
"""${post.text.slice(0, 1500)}"""
Дай 3 варианта ответа (каждый до 200 символов, язык — как у поста), по одному на строку, без нумерации и кавычек.
Остроумно и по теме поста, как живой человек из комьюнити; без ссылок, без «скачайте/попробуйте», без лести и троллинга.
Никаких цен, доходности, «вырастет в цене», торговли, инвестиций, ставок, рандома и розыгрышей — даже если пост про это;
в таком случае шути про сам Telegram, эмодзи или статусы. Если пост не даёт повода для уместного ответа — выведи только слово SKIP.`;
  const out = execFileSync('claude', ['-p', prompt, '--model', 'haiku', '--max-turns', '1', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { cwd: HERE, encoding: 'utf8', timeout: 180000 }).trim();
  return out === 'SKIP' ? [] : out.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3);
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
    await tg('sendMessage', { chat_id: id, parse_mode: 'HTML', disable_web_page_preview: true,
      text: `🆕 <b>@${c.x}</b>: ${esc(p.text.slice(0, 300))}${p.text.length > 300 ? '…' : ''}\n\n` +
        `Ответы (нажми, чтобы скопировать):\n${d.map((x) => `<code>${esc(x)}</code>`).join('\n\n')}`,
      reply_markup: { inline_keyboard: [[{ text: `Открыть @${c.x} в X`, url: `https://x.com/${c.x}` }],
        [{ text: 'Пост в Telegram', url: `https://t.me/${c.tg}/${p.id}` }]] } });
  }
}
if (!dry) writeFileSync(statePath, JSON.stringify(state, null, 2));
