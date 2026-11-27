// Twice a day: a short Haiku + WebSearch pass over this week's TikTok / X trends → state/trends.json.
// daily.mjs reads the compact result, so post copy follows trends without searching on every call.
// Usage: node agent/trends.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { execFileSync('claude', ['--version'], { stdio: 'ignore' }); }
catch { execFileSync('npm', ['install', '-g', '--silent', '@anthropic-ai/claude-code'], { stdio: 'inherit' }); }

const ask = `Сделай 2–3 поиска WebSearch: тренды TikTok в России на этой неделе (форматы, мемы, хэштеги) и
что сейчас обсуждают в X про Telegram / мессенджеры / эмодзи. Сегодня ${new Date().toISOString().slice(0, 10)}.
Верни ТОЛЬКО компактный JSON (без пояснений):
{"tiktok_hashtags":["до 8 трендовых русскоязычных хэштегов"],"tiktok_formats":["до 4 трендовых форматов/мемов одной фразой"],
"x_topics":["до 4 тем, о которых сейчас шутят в X, применимых к Telegram/эмодзи"],"tone":"1 фраза о тоне недели"}
Пропусти всё про деньги, крипту, ставки, политику, трагедии, реальных людей и всё для детей.`;
const out = execFileSync('claude', ['-p', ask, '--model', 'haiku', '--allowedTools', 'WebSearch', '--max-turns', '5',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'inherit'] });
const trends = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
mkdirSync(resolve(ROOT, 'state'), { recursive: true });
writeFileSync(resolve(ROOT, 'state/trends.json'), JSON.stringify({ updated: new Date().toISOString(), ...trends }, null, 2));
console.log(JSON.stringify(trends));
