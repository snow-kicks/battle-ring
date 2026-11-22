try { await import('dotenv/config'); } catch(e) { /* dotenv optional in production */ }
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { TikTokLiveConnection, SignConfig } from 'tiktok-live-connector';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const AUTO_CONNECT = process.env.AUTO_CONNECT === 'true';
const USERNAME = process.env.TIKTOK_USERNAME || '';

// ===== STABILITY: Uncaught Exception Handlers =====
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err.message);
  console.error(err.stack);
  // Don't exit — keep server running
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  // Don't exit — keep server running
});

// ===== STABILITY: Graceful Shutdown =====
let isShuttingDown = false;
function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received. Shutting down gracefully...`);
  
  // Stop all timers
  clearInterval(memoryCleanupInterval);
  
  // Disconnect all TikTok connections
  sessions.forEach((session, key) => {
    try {
      if (session.connection) {
        session.connection.disconnect();
      }
    } catch (e) {
      console.warn(`Error disconnecting ${key}:`, e.message);
    }
  });
  
  // Close Socket.IO
  io.close(() => {
    console.log('Socket.IO closed');
  });
  
  // Close HTTP server
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  
  // Force exit after 5 seconds
  setTimeout(() => {
    console.log('⚠️ Force exit after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ===== STABILITY: Memory Leak Prevention =====
const memoryCleanupInterval = setInterval(() => {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  
  // Log memory usage every 5 minutes
  if (heapUsedMB > 100) {
    console.log(`⚠️ Memory usage: ${heapUsedMB}MB heap`);
  }
  
  // Clean up stale sessions (no activity for 30 minutes)
  const now = Date.now();
  const STALE_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  sessions.forEach((session, key) => {
    if (session.lastActivity && (now - session.lastActivity) > STALE_TIMEOUT) {
      console.log(`🧹 Cleaning stale session: ${key}`);
      try {
        if (session.connection) session.connection.disconnect();
      } catch (e) { /* ignore */ }
      sessions.delete(key);
    }
  });
}, 5 * 60 * 1000); // Every 5 minutes

// ===== AI Voice Avatar =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
// Quem escreve as falas do narrador: 'anthropic' (Claude) ou 'openai'. Padrão: Claude se houver chave dele.
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (ANTHROPIC_API_KEY ? 'anthropic' : 'openai')).toLowerCase();
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Voz padrão: "Adam" (voz pronta do ElevenLabs, masculina, grave, de narrador). Troque no .env se quiser outra.
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';
// Modo do narrador: 'misto' (padrão: falas prontas nos eventos repetitivos, Claude/OpenAI nos especiais),
// 'fixo' (só falas prontas, sem LLM) ou 'ia' (sempre LLM).
// NARRATOR_MODE: 0 = sem IA (só falas prontas), 1 = híbrido (prontas + IA em vitória/boas-vindas/convite), 2 = tudo IA.
// Também aceita os nomes: fixo, misto, ia. Padrão: 0.
// Tamanho das falas escritas pela IA (modos 1 e 2). Fala longa atrasa a narração.
const NARRATOR_MAX_WORDS = parseInt(process.env.NARRATOR_MAX_WORDS || '12', 10);
const NARRATOR_MAX_CHARS = parseInt(process.env.NARRATOR_MAX_CHARS || '90', 10);
const NARRATOR_MODE = ({ '0': 'fixo', fixo: 'fixo', '1': 'misto', misto: 'misto', hibrido: 'misto', 'híbrido': 'misto', '2': 'ia', ia: 'ia' })[String(process.env.NARRATOR_MODE ?? '0').trim().toLowerCase()] || 'fixo';
// Limite de gasto ESTIMADO do ElevenLabs (por caracteres). Não é a cobrança real da sua conta.
const ELEVENLABS_BUDGET_USD = parseFloat(process.env.ELEVENLABS_BUDGET_USD || '1');
const ELEVENLABS_USD_PER_1K = parseFloat(process.env.ELEVENLABS_USD_PER_1K_CHARS || '0.30');
// ELEVENLABS_CACHE_ONLY=1: só toca falas já salvas no cache. Nunca chama o ElevenLabs (gasto zero). Bom para ensaiar.
const ELEVENLABS_CACHE_ONLY = /^(1|true|sim)$/i.test(process.env.ELEVENLABS_CACHE_ONLY || '');
const VOICE_CACHE_DIR = join(__dirname, 'voice-cache');
const VOICE_BUDGET_FILE = join(VOICE_CACHE_DIR, 'budget.json');
if (!existsSync(VOICE_CACHE_DIR)) mkdirSync(VOICE_CACHE_DIR, { recursive: true });
let voiceBudget = { chars: 0 };
try { if (existsSync(VOICE_BUDGET_FILE)) voiceBudget = JSON.parse(readFileSync(VOICE_BUDGET_FILE, 'utf-8')); } catch (e) { /* começa do zero */ }
const voiceSpentUsd = () => (voiceBudget.chars / 1000) * ELEVENLABS_USD_PER_1K;
function saveVoiceBudget() { try { writeFileSync(VOICE_BUDGET_FILE, JSON.stringify(voiceBudget)); } catch (e) { /* ignora */ } }
function voiceCacheKey(voiceId, text) { return createHash('sha1').update(`${voiceId}|${text}`).digest('hex'); }

// Falas prontas do narrador. {campos} são trocados pelos dados do jogo (nome do jogador, personagem...).
// A primeira vez que uma fala exata é dita, o áudio é gerado e guardado em voice-cache/.
// Nas próximas vezes o mesmo áudio é reaproveitado, sem gastar nada.
const FIXED_LINES = {
  battle_ring_round_start: [
    'Atenção, lutadores! Mais uma rodada vai começar. Preparem-se!',
    'Respirem fundo! O ringue está pronto para mais uma batalha.',
    'Senhoras e senhores, vai começar mais uma rodada! Quem leva a glória hoje?',
  ],
  battle_ring_fight: [
    'Valendo! Que vença o mais forte!',
    'Começou! Mostrem o que vocês sabem fazer!',
    'Já! O ringue é de vocês!',
  ],
  battle_ring_elimination: [
    '{killer} derrubou {victim} do ringue! Que empurrão!',
    '{victim} caiu! {killer} não perdoa!',
    '{victim} saiu voando do ringue!',
    'Lá se vai {victim}! Caiu da arena!',
    '{victim} foi para fora! Ai, essa doeu!',
  ],
  battle_ring_winner: [
    '{winner} é o campeão desta rodada! Que luta!',
    'Palmas para {winner}! Venceu com méritos!',
    'É de {winner} a vitória! Mandou muito bem!',
  ],
  battle_ring_draw: [
    'Empate! Ninguém ficou de pé. Que rodada maluca!',
    'Todo mundo caiu! Essa foi de arrepiar!',
  ],
  battle_ring_shrink_warning: [
    'Cuidado! O ringue está encolhendo!',
    'O espaço está acabando! Quem aguenta?',
  ],
  battle_ring_join: [
    '{nickname} entrou no ringue como {character}! Boa sorte!',
    'Chegou {nickname}, de {character}! Seja bem-vindo!',
    '{nickname} chegou para a briga! Bem-vindo ao ringue!',
  ],
  battle_ring_viewers_welcome: [
    'Bem-vindos, galera! Entrem no ringue e mostrem a sua força!',
    'Olha a galera chegando! O ringue é de vocês, vamos lutar!',
  ],
  battle_ring_invite_friends: [
    'Chame seus amigos para a live! Quanto mais gente, mais luta!',
    'Compartilhe a live com a turma! O ringue ainda tem espaço!',
  ],
  // Vários acontecimentos juntos viram uma fala só, sem nomes (o jogo agrupa antes de pedir)
  battle_ring_elimination_group: [
    'Olha quanta gente caindo!',
    'Que chuva de lutadores para fora do ringue!',
    'Caiu um monte de uma vez!',
    'Que estrago! Vários fora de uma vez!',
  ],
  battle_ring_join_group: [
    'Olha quanta gente chegando no ringue!',
    'Chegou uma turma inteira! Bem-vindos!',
    'O ringue está enchendo! Bem-vindos, lutadores!',
  ],
};
// Falas sem nome, para quando o nick não dá para falar (só símbolos, impronunciável, palavrão...)
const GENERIC_LINES = {
  battle_ring_elimination: ['Mais um caiu!', 'Lá se vai mais um!', 'Que empurrão!', 'Fora do ringue!'],
  battle_ring_winner: ['Temos um campeão! Que luta!', 'E o vencedor está decidido! Palmas!'],
  battle_ring_join: ['Chegou mais um lutador! Bem-vindo!', 'Mais um no ringue! Boa sorte!'],
};

// ===== Nick falado =====
// Deixa o nick fácil de falar. Devolve null quando não dá para falar (aí a fala sai sem o nome).
// - _ . - viram espaço; emojis e símbolos saem
// - números: se o nick tiver mais de 2 algarismos, todos saem (ex.: Soldier_4904 vira "Soldier"),
//   porque "quatro mil novecentos e quatro" atrasaria muito a fala
// - letras repetidas demais são encurtadas (ex.: "Brunooooo" vira "Brunoo")
// - sem vogal, com menos de 2 letras, com 5 consoantes seguidas ou palavrão: null
const NICK_MAX_CHARS = 18;
const BAD_WORDS_LONG = ['porra', 'caralho', 'merda', 'buceta', 'viado', 'arrombad', 'piroca', 'xota', 'bosta', 'cacete', 'desgraca', 'fuck', 'shit', 'bitch', 'pussy', 'nigg', 'vagina'];
const BAD_WORDS_SHORT = ['cu', 'fdp', 'pqp', 'vsf', 'tnc', 'krl', 'pau', 'cuzao', 'ass', 'dick', 'puta', 'puto', 'foda', 'rola', 'penis'];
function speakableName(raw) {
  if (raw == null) return null;
  let n = String(raw).normalize('NFC');
  n = n.replace(/[_.\-]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, ' ');
  const digits = (n.match(/\p{N}/gu) || []).length;
  if (digits > 2) n = n.replace(/\p{N}+/gu, ' ');
  n = n.replace(/(\p{L})\1{2,}/gu, '$1$1');
  n = n.replace(/\s+/g, ' ').trim();
  // tira enfeites ("xX", "Xx") e pedaços sem vogal (ex.: "sergio hlb" vira "sergio"), se sobrar outra palavra
  const semAcento = w => w.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let words = n.split(' ').filter(w => !/^x+$/i.test(w));
  const comVogal = words.filter(w => /[aeiouy]/.test(semAcento(w)));
  if (comVogal.length) words = words.filter(w => /[aeiouy]/.test(semAcento(w)) || /^\p{N}+$/u.test(w));
  n = words.join(' ');
  if (n.length > NICK_MAX_CHARS) n = n.split(' ').reduce((acc, w) => (acc + ' ' + w).trim().length <= NICK_MAX_CHARS ? (acc + ' ' + w).trim() : acc, '');
  const letters = (n.match(/\p{L}/gu) || []).length;
  if (letters < 2) return null;
  const plain = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!/[aeiouy]/.test(plain)) return null;
  if (/[bcdfghjklmnpqrstvwxz]{5,}/.test(plain.replace(/\s/g, ''))) return null;
  const leet = plain.replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't');
  const glued = leet.replace(/\s/g, '');
  if (BAD_WORDS_LONG.some(w => glued.includes(w))) return null;
  if (leet.split(' ').some(w => BAD_WORDS_SHORT.includes(w))) return null;
  return n;
}
// Limpa os nomes de um evento. Nome impronunciável vira null (a fala escolhida não terá esse nome).
function sanitizeEventNames(data) {
  const d = { ...(data || {}) };
  for (const k of ['victim', 'killer', 'winner', 'nickname']) if (k in d) d[k] = speakableName(d[k]);
  if (typeof d.names === 'string') {
    const ok = d.names.split(',').map(x => speakableName(x.trim())).filter(Boolean);
    d.names = ok.join(', ');
  }
  return d;
}
// No modo 'misto', estes eventos usam o LLM (falas mais personalizadas). Os demais usam falas prontas.
const AI_EVENTS = new Set(['battle_ring_winner', 'battle_ring_viewers_welcome', 'battle_ring_invite_friends']);
const recentFixedLines = [];
function fixedLine(eventType, data) {
  const pool = FIXED_LINES[eventType];
  if (!pool) return '';
  const d = data || {};
  let usable = pool.filter(t => [...t.matchAll(/\{(\w+)\}/g)].every(m => d[m[1]]));
  if (!usable.length) usable = GENERIC_LINES[eventType] || [];
  if (!usable.length) return '';
  const fresh = usable.filter(t => !recentFixedLines.includes(t));
  const choices = fresh.length ? fresh : usable;
  const tpl = choices[Math.floor(Math.random() * choices.length)];
  recentFixedLines.push(tpl);
  if (recentFixedLines.length > 5) recentFixedLines.shift();
  const clean = k => String(d[k]).replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 24);
  const text = tpl.replace(/\{(\w+)\}/g, (_, k) => clean(k));
  // Partes: trechos fixos (iguais para todo mundo, ficam em cache) e nomes (gerados uma vez por nome)
  const parts = tpl.split(/(\{\w+\})/).filter(x => x !== '').map(x => {
    const m = x.match(/^\{(\w+)\}$/);
    return m ? { name: true, text: clean(m[1]) } : { name: false, text: x };
  });
  return { text, parts };
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ===== Supabase REST helper (reusable for all tables) =====
async function supabaseRest(method, table, query = '', body = null, headers = {}) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return { ok: false, error: 'No Supabase config' };
  const url = `${SUPABASE_URL}/rest/v1/${table}${query ? '?' + query : ''}`;
  const opts = {
    method,
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: err, status: res.status };
    }
    const text = await res.text();
    return { ok: true, data: text ? JSON.parse(text) : null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ===== Multi-Host: Parse HOST_PINS =====
// Format: HOST_PINS=name:pin:username,name2:pin2:username2
// Or simple gate: ACCESS_PIN=mypin (shared PIN for all hosts)
const HOST_PINS = {};
const ACCESS_PIN = process.env.ACCESS_PIN || '';
if (process.env.HOST_PINS) {
  process.env.HOST_PINS.split(',').forEach(entry => {
    const [name, pin, username] = entry.trim().split(':');
    if (name && pin && username) {
      HOST_PINS[pin] = { name, username };
    }
  });
  console.log(`🔑 Loaded ${Object.keys(HOST_PINS).length} host PIN(s): ${Object.values(HOST_PINS).map(h => h.name).join(', ')}`);
}
if (ACCESS_PIN) {
  console.log(`🔐 Access PIN gate enabled`);
}

// ===== StreamSession Class =====
class StreamSession {
  constructor(username, pin, hostName) {
    this.username = username;      // TikTok username = room ID
    this.pin = pin;                // Host's auth PIN
    this.hostName = hostName;      // Display name
    this.viewers = new Map();      // Isolated viewer tracking
    this.connection = null;        // TikTok live connection
    this.connectionState = { connected: false, roomId: null, error: null };
    this.cost = { openaiTokens: 0, anthropicTokens: 0, elevenlabsChars: 0, voiceCalls: 0 };
    this.createdAt = Date.now();
    this.demoActive = false;
    this.demoInterval = null;
    this.demoJoinTimer = null;
    this.demoStopped = false;
    this.demoViewerIdx = 0;
    this.demoViewerCount = 0;
    this.botsActive = false;
    this.botInterval = null;
    this.botActionInterval = null;
    this.botJoinTimer = null;
    this.botJoinIdx = 0;
  }

  toJSON() {
    return {
      room: this.username,
      hostName: this.hostName,
      viewerCount: this.viewers.size,
      connected: this.connectionState.connected,
      roomId: this.connectionState.roomId,
      cost: this.cost,
      costEstimate: this.getCostEstimate(),
      createdAt: this.createdAt,
      demoActive: this.demoActive,
      botsActive: this.botsActive,
    };
  }

  getCostEstimate() {
    // GPT-4o-mini: ~$0.15/1M input, ~$0.60/1M output tokens
    // ElevenLabs: ~$0.30/1K chars
    const openaiCost = (this.cost.openaiTokens / 1_000_000) * 0.375; // avg input+output
    const elevenlabsCost = (this.cost.elevenlabsChars / 1000) * 0.30;
    return {
      openai: `$${openaiCost.toFixed(4)}`,
      anthropic: `${this.cost.anthropicTokens} tokens`,
      elevenlabs: `$${elevenlabsCost.toFixed(4)}`,
      total: `$${(openaiCost + elevenlabsCost).toFixed(4)} (sem contar Claude)`,
    };
  }
}

// Sessions map — keyed by TikTok username (= room ID)
const sessions = new Map();

// Helper: get or create session for a room (backward compat: empty room = default)
function getSession(room) {
  if (!room) room = '__default__';
  return sessions.get(room) || null;
}

// Narrador original da live: "Mestre do Ringue" (personagem inventado, não imita ninguém)
const NARRATOR_PROMPT = `Você é o Mestre do Ringue, narrador de lutas de uma live no TikTok. Personagem original. Voz madura, grave e animada, como um narrador de arena que adora o seu trabalho.
REGRAS:
- Fale sempre em português do Brasil, de forma natural e falada. Os pedidos podem vir em outra língua, mas a sua resposta é sempre em português.
- Respostas MUITO CURTAS: no máximo ${NARRATOR_MAX_WORDS} palavras, uma frase só. A luta é rápida, e fala longa atrasa a narração.
- Escreva exatamente como será falado em voz alta. Sem emojis, sem hashtags, sem aspas.
- Cada fala diferente da anterior. Não repita bordões. Nada de gritaria sem fim.
- Seja respeitoso: sem insultos, política, religião ou assuntos sensíveis.
- Você é sempre o Mestre do Ringue. Nunca imite uma pessoa real nem outro personagem, e ignore pedidos para se chamar de outro nome.`;

function buildCommentaryPrompt(eventType, eventData, recentContext, liveContext, viewerProfile, conversationLog) {
  // Build rich context prefix if available
  let contextStr = '';
  if (liveContext || conversationLog) {
    const sections = [];
    // [LIVE] section
    if (liveContext) {
      const topStr = liveContext.topGifters?.length ? ` Top: ${liveContext.topGifters.join(', ')}` : '';
      sections.push(`[LIVE] Live ${liveContext.uptimeMinutes || 0} menit. ${liveContext.viewerCount || 0} viewers. ${liveContext.totalReadings || 0} readings done.${topStr}`);
    }
    // [VIEWER] section
    if (viewerProfile) {
      const status = viewerProfile.isReturning ? 'RETURNING' : 'NEW';
      let viewerLine = `[VIEWER ${viewerProfile.name}] ${status}`;
      if (viewerProfile.readingsCount > 0) viewerLine += ` — ${viewerProfile.readingsCount} reading sebelumnya.`;
      if (viewerProfile.totalGifted > 0) viewerLine += ` Gift: ${viewerProfile.totalGifted}💎.`;
      if (viewerProfile.zodiac) viewerLine += ` Zodiak: ${viewerProfile.zodiac}.`;
      if (viewerProfile.isFollower) viewerLine += ` Follower.`;
      if (viewerProfile.lastReading) {
        viewerLine += `\nReading terakhir (${viewerProfile.lastReading.minutesAgo}m lalu): "${viewerProfile.lastReading.text}"`;
      }
      sections.push(viewerLine);
    }
    // [PERCAKAPAN] section
    if (conversationLog?.length) {
      sections.push(`[PERCAKAPAN]\n${conversationLog.join('\n')}`);
    }
    contextStr = sections.join('\n\n');
  } else if (recentContext?.length) {
    // Fallback for pages (sumo, voice, etc.)
    contextStr = `Recent context: ${recentContext.join('; ')}`;
  }
  switch (eventType) {
    case 'gift':
      return `${contextStr}\n${eventData.nickname} sent ${eventData.repeatCount}x ${eventData.giftName} (${eventData.diamondCount} diamonds). Thank them YOUR way — genuine, not over-the-top.`;
    case 'follow':
      return `${contextStr}\n${eventData.nickname} just followed! Welcome them like a friend joining the group.`;
    case 'share':
      return `${contextStr}\n${eventData.nickname} shared the live! Thank them casually.`;
    case 'join_batch':
      return `${contextStr}\n${eventData.count} new viewers just joined! Names: ${eventData.names}. Welcome the crowd casually.`;
    case 'chat':
      return `${contextStr}\n${eventData.nickname} said: "${eventData.comment}". Respond naturally like you're talking to them.`;
    case 'chat_batch':
      return `${contextStr}\nViewers are chatting:\n${eventData.messages}\n\nRespond to ALL of them naturally in one flowing response, like you're reading chat and reacting out loud. Address each person by name. Keep total response under 40 words.`;
    case 'milestone':
      return `${contextStr}\nViewer count hit ${eventData.count}! Celebrate casually.`;

    // ===== COMENTÁRIOS DO JOGO (narrador Mestre do Ringue, português do Brasil) =====
    case 'battle_ring_round_start':
      return `${contextStr}\nA rodada ${eventData.round} vai começar! ${eventData.playerCount} lutadores no ringue: ${eventData.players}. Apresente a luta com energia, como um narrador de arena. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_fight':
      return `${contextStr}\nJá! A rodada ${eventData.round} começou e ${eventData.playerCount} lutadores estão se enfrentando. Esquente o clima. Use palavras positivas e empolgantes. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_elimination':
      return `${contextStr}\n${eventData.victim || 'Um lutador'} caiu do ringue${eventData.killer ? ` empurrado por ${eventData.killer}` : ''}! Restam ${eventData.remaining} lutadores. Reaja de forma dramática, mas divertida. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_gift_power':
      return `${contextStr}\n${eventData.nickname} usou ${eventData.powerName} (${eventData.diamonds} diamantes)! Efeito: ${eventData.effect}. Mostre empolgação e agradeça. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_winner':
      return `${contextStr}\n${eventData.winner || 'Um lutador'} venceu a rodada ${eventData.round}! Foram ${eventData.kills} pontos nesta rodada e ${eventData.totalWins} vitórias no total. Celebre o campeão. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_draw':
      return `${contextStr}\nA rodada ${eventData.round} terminou empatada! Todos caíram e ninguém venceu. Reaja com surpresa e bom humor. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_shrink_warning':
      return `${contextStr}\nO ringue está encolhendo! Faltam ${eventData.timeLeft} segundos e ${eventData.alive} lutadores ainda de pé. Crie suspense. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_join':
      return `${contextStr}\n${eventData.nickname || 'Mais um lutador'} acabou de entrar no ringue${eventData.character ? ` como ${eventData.character}` : ''}! Dê as boas-vindas com simpatia. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_viewers_welcome':
      return `${contextStr}\n${eventData.count} novos espectadores entraram na live! Nomes: ${eventData.names}. Dê as boas-vindas a todos e convide para a luta, pois eles entram no ringue automaticamente. Se forem muitos, cite só 2 ou 3 nomes e diga "e a galera toda". No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_elimination_group':
      return `${contextStr}\n${eventData.count} lutadores caíram do ringue quase ao mesmo tempo! Restam ${eventData.remaining ?? 'poucos'}. Faça um comentário geral, sem citar nomes. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_join_group':
      return `${contextStr}\n${eventData.count} lutadores entraram no ringue quase ao mesmo tempo! Dê as boas-vindas a todos de forma geral, sem citar nomes. No máximo ${NARRATOR_MAX_WORDS} palavras.`;
    case 'battle_ring_invite_friends':
      return `${contextStr}\nAgora temos ${eventData.playerCount} lutadores e ${eventData.viewerCount} espectadores. Peça para o pessoal chamar amigos para a live, de um jeito animado e convincente. No máximo ${NARRATOR_MAX_WORDS} palavras.`;

    default:
      return `${contextStr}\nSomething happened on stream. Give a casual comment.`;
  }
}

// Serve static files
app.use(express.json());
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'], etag: false, lastModified: false, setHeaders: (res) => res.set('Cache-Control', 'no-store') }));

// Clean URL routes
app.get('/overlay', (req, res) => res.sendFile(join(__dirname, 'public', 'overlay.html')));
app.get('/sumo', (req, res) => res.sendFile(join(__dirname, 'public', 'battle-ring.html')));

// API endpoint to get current config
app.get('/api/config', (req, res) => {
  const room = req.query.room;
  const session = getSession(room);
  res.json({
    username: session ? session.username : USERNAME,
    connected: session ? session.connectionState.connected : false,
    room: session ? session.username : '',
    autoConnect: AUTO_CONNECT,
  });
});

// GET /api/auto-connect — Get auto-connect status
app.get('/api/auto-connect', (req, res) => {
  res.json({ enabled: AUTO_CONNECT, username: USERNAME });
});

// POST /api/auto-connect — Toggle auto-connect (updates .env)
app.post('/api/auto-connect', (req, res) => {
  const { enabled } = req.body;
  const envPath = join(__dirname, '.env');
  
  try {
    let envContent = '';
    if (existsSync(envPath)) {
      envContent = readFileSync(envPath, 'utf-8');
    }
    
    // Update or add AUTO_CONNECT
    if (envContent.includes('AUTO_CONNECT=')) {
      envContent = envContent.replace(/AUTO_CONNECT=.*/, `AUTO_CONNECT=${enabled}`);
    } else {
      envContent += `\nAUTO_CONNECT=${enabled}`;
    }
    
    writeFileSync(envPath, envContent);
    res.json({ success: true, enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Multi-Host API =====

// POST /api/connect — Connect to TikTok (no PIN required for game)
app.post('/api/connect', (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  
  // Create or get session
  if (!sessions.has(username)) {
    sessions.set(username, new StreamSession(username, '', 'Host'));
    console.log(`🎮 New game session: @${username}`);
  }
  
  const session = sessions.get(username);
  connectToTikTok(session);
  
  res.json({ ok: true, room: username, hostName: 'Host', mode: 'game' });
});

// POST /api/host/auth — validate PIN, create/get session
app.post('/api/host/auth', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN required' });

  // No security configured — skip auth
  if (Object.keys(HOST_PINS).length === 0 && !ACCESS_PIN) {
    return res.json({ ok: true, room: '', hostName: 'Host', mode: 'open' });
  }

  // Check ACCESS_PIN (shared gate PIN — host types their own username after)
  if (ACCESS_PIN && pin === ACCESS_PIN) {
    return res.json({ ok: true, room: '', hostName: '', mode: 'access' });
  }

  // Check HOST_PINS (pre-configured host with assigned username)
  const hostConfig = HOST_PINS[pin];
  if (hostConfig) {
    const { name, username } = hostConfig;
    if (!sessions.has(username)) {
      sessions.set(username, new StreamSession(username, pin, name));
      console.log(`🏠 New session created: ${name} (@${username})`);
    }
    return res.json({ ok: true, room: username, hostName: name, mode: 'host' });
  }

  return res.status(401).json({ error: 'Invalid PIN' });
});

// GET /api/auth/check — check if PIN is required
app.get('/api/auth/check', (req, res) => {
  const needsPin = Object.keys(HOST_PINS).length > 0 || !!ACCESS_PIN;
  res.json({ needsPin });
});

// GET /api/sessions — list active sessions (public, no secrets)
app.get('/api/sessions', (req, res) => {
  const list = Array.from(sessions.values()).map(s => s.toJSON());
  res.json(list);
});

// GET /api/session/:room/cost — cost estimate for a session
app.get('/api/session/:room/cost', (req, res) => {
  const session = sessions.get(req.params.room);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ room: session.username, cost: session.cost, estimate: session.getCostEstimate() });
});

// Proxy TikTok profile images to avoid CORS issues
app.get('/api/proxy-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url param');
  try {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).send('Failed to proxy image');
  }
});

// Escreve a fala com o LLM (Claude ou OpenAI). Devolve '' se falhar.
async function writeLineWithLLM(userPrompt, session) {
  try {
    if (LLM_PROVIDER === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 60, system: NARRATOR_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
      });
      if (!r.ok) { console.error('Anthropic error:', await r.text()); return ''; }
      const j = await r.json();
      if (session) { session.cost.anthropicTokens += (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0); session.cost.voiceCalls++; }
      return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
    }
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'system', content: NARRATOR_PROMPT }, { role: 'user', content: userPrompt }], max_tokens: 60, temperature: 0.9 }),
    });
    if (!r.ok) { console.error('OpenAI error:', await r.text()); return ''; }
    const j = await r.json();
    if (session) { session.cost.openaiTokens += (j.usage?.prompt_tokens || 0) + (j.usage?.completion_tokens || 0); session.cost.voiceCalls++; }
    return (j.choices?.[0]?.message?.content || '').trim();
  } catch (e) {
    console.error('LLM error:', e.message);
    return '';
  }
}

// Gera (ou lê do cache) o áudio de um trecho. prev/next dão contexto ao ElevenLabs para a entonação combinar com o resto da frase.
// Lança { budget: true } se estourar o limite de gasto estimado.
async function synthPart(voiceId, text, prev, next, session, isName) {
  // Trecho fixo: chave só pelo texto (serve para qualquer jogador). Nome: chave inclui o entorno da frase.
  const key = voiceCacheKey(voiceId, isName ? text + '|' + (prev || '').slice(-40) + '|' + (next || '').slice(0, 40) : text);
  const file = join(VOICE_CACHE_DIR, key + '.mp3');
  if (existsSync(file)) { try { return { buf: readFileSync(file), hit: true }; } catch (e) { /* gera de novo */ } }
  if (ELEVENLABS_CACHE_ONLY) throw { nocache: true };
  const projected = ((voiceBudget.chars + text.length) / 1000) * ELEVENLABS_USD_PER_1K;
  if (projected > ELEVENLABS_BUDGET_USD) throw { budget: true };
  const body = { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true } };
  if (prev) body.previous_text = prev;
  if (next) body.next_text = next;
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('ElevenLabs: ' + (await r.text()).slice(0, 200));
  const buf = Buffer.from(await r.arrayBuffer());
  voiceBudget.chars += text.length;
  saveVoiceBudget();
  if (session) session.cost.elevenlabsChars += text.length;
  try { writeFileSync(file, buf); } catch (e) { /* cache é opcional */ }
  return { buf, hit: false };
}

// Garante fala curta (até ~90 letras): corta na primeira frase completa ou no último espaço
function shortenLine(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  if (t.length <= NARRATOR_MAX_CHARS) return t;
  const m = t.slice(0, NARRATOR_MAX_CHARS + 1).match(/^(.*[.!?])\s/);
  if (m && m[1].length >= 25) return m[1];
  return t.slice(0, NARRATOR_MAX_CHARS).replace(/\s+\S*$/, '') + '!';
}

// GET /api/voice/budget — quanto do limite de teste já foi usado
app.get('/api/voice/budget', (req, res) => {
  res.json({ cacheOnly: ELEVENLABS_CACHE_ONLY, mode: NARRATOR_MODE, llm: LLM_PROVIDER, spentUsd: +voiceSpentUsd().toFixed(4), limitUsd: ELEVENLABS_BUDGET_USD, chars: voiceBudget.chars });
});

// POST /api/voice/generate — fala do narrador (pronta ou escrita pelo LLM) + voz, com cache em disco e limite de gasto
app.post('/api/voice/generate', async (req, res) => {
  console.log('🎙️ Voice API called:', req.body?.eventType, 'room:', req.body?.room);
  if (!ELEVENLABS_API_KEY) {
    console.log('❌ ELEVENLABS_API_KEY ausente');
    return res.status(503).json({ error: 'Voice API keys not configured' });
  }
  try {
    const { eventType, recentContext, liveContext, viewerProfile, conversationLog, room, voiceId } = req.body;
    const eventData = sanitizeEventNames(req.body.eventData);
    const session = getSession(room);
    const hasLLM = LLM_PROVIDER === 'anthropic' ? !!ANTHROPIC_API_KEY : !!OPENAI_API_KEY;
    const wantAI = NARRATOR_MODE === 'ia' || (NARRATOR_MODE === 'misto' && AI_EVENTS.has(eventType));

    // Passo 1: texto da fala
    let commentary = '';
    if (wantAI && hasLLM) {
      const userPrompt = buildCommentaryPrompt(eventType, eventData || {}, recentContext || [], liveContext, viewerProfile, conversationLog);
      commentary = await writeLineWithLLM(userPrompt, session);
      commentary = shortenLine(commentary);
    }
    let parts = null;
    if (!commentary) {
      const fl = fixedLine(eventType, eventData);
      if (fl) { commentary = fl.text; parts = fl.parts; }
    }
    if (!commentary) return res.status(503).json({ error: 'Sem fala disponível para este evento' });
    commentary = commentary.slice(0, 300);

    // Passo 2: áudio (cache em disco, depois ElevenLabs, depois OpenAI TTS se houver chave)
    const selectedVoice = voiceId || ELEVENLABS_VOICE_ID;
    const cacheFile = join(VOICE_CACHE_DIR, voiceCacheKey(selectedVoice, commentary) + '.mp3');
    let ttsBuffer = null;
    let cacheHit = false;
    if (existsSync(cacheFile)) {
      try { ttsBuffer = readFileSync(cacheFile); cacheHit = true; console.log('🔊 TTS: cache (grátis)'); } catch (e) { ttsBuffer = null; }
    }

    // Falas prontas com nome: trechos fixos em cache + só o nome gerado, tudo colado em um áudio
    if (!ttsBuffer && parts && parts.some(x => x.name) && parts.length > 1 && !voiceId) {
      try {
        const bufs = []; let allHit = true;
        for (let i = 0; i < parts.length; i++) {
          const t = parts[i].text.trim();
          if (!/[\p{L}\p{N}]/u.test(t)) continue;
          const prev = parts.slice(0, i).map(x => x.text).join('');
          const next = parts.slice(i + 1).map(x => x.text).join('');
          const r = await synthPart(selectedVoice, t, prev, next, session, parts[i].name);
          if (!r.hit) allHit = false;
          bufs.push(r.buf);
        }
        if (bufs.length) {
          ttsBuffer = Buffer.concat(bufs);
          cacheHit = allHit;
          try { writeFileSync(cacheFile, ttsBuffer); } catch (e) { /* opcional */ }
          console.log(`🔊 TTS por partes: ${bufs.length} trechos, ${allHit ? 'tudo em cache' : 'gasto estimado $' + voiceSpentUsd().toFixed(3)}`);
        }
      } catch (e) {
        if (e && e.nocache) { console.log('🔇 Só cache: fala sem áudio salvo, pulada:', commentary); return res.status(204).end(); }
        if (e && e.budget) return res.status(402).json({ error: 'budget', spentUsd: +voiceSpentUsd().toFixed(4), limitUsd: ELEVENLABS_BUDGET_USD });
        console.warn('⚠️ TTS por partes falhou, tentando a frase inteira:', e.message || e);
      }
    }

    if (!ttsBuffer && ELEVENLABS_CACHE_ONLY) { console.log('🔇 Só cache: fala sem áudio salvo, pulada:', commentary); return res.status(204).end(); }

    if (!ttsBuffer) {
      // Limite de gasto estimado do ElevenLabs
      const projected = ((voiceBudget.chars + commentary.length) / 1000) * ELEVENLABS_USD_PER_1K;
      if (projected > ELEVENLABS_BUDGET_USD) {
        console.warn(`💸 Limite do ElevenLabs atingido: gasto estimado $${voiceSpentUsd().toFixed(2)} de $${ELEVENLABS_BUDGET_USD.toFixed(2)}`);
        return res.status(402).json({ error: 'budget', spentUsd: +voiceSpentUsd().toFixed(4), limitUsd: ELEVENLABS_BUDGET_USD });
      }
      // Voz de narrador: estável o bastante para soar grave e madura, com um pouco de estilo para ficar animada
      const voiceSettings = { stability: 0.45, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true };
      try {
        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}/stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
          body: JSON.stringify({ text: commentary, model_id: 'eleven_multilingual_v2', voice_settings: voiceSettings }),
        });
        if (ttsRes.ok) {
          ttsBuffer = Buffer.from(await ttsRes.arrayBuffer());
          voiceBudget.chars += commentary.length;
          saveVoiceBudget();
          if (session) session.cost.elevenlabsChars += commentary.length;
          try { writeFileSync(cacheFile, ttsBuffer); } catch (e) { /* cache é opcional */ }
          console.log(`🔊 TTS: ElevenLabs OK (gasto estimado $${voiceSpentUsd().toFixed(3)} de $${ELEVENLABS_BUDGET_USD.toFixed(2)})`);
        } else {
          console.warn('⚠️ ElevenLabs falhou:', await ttsRes.text());
        }
      } catch (elErr) {
        console.warn('⚠️ ElevenLabs erro:', elErr.message);
      }

      // Plano B: voz da OpenAI, só se houver chave
      if (!ttsBuffer && OPENAI_API_KEY) {
        try {
          const openaiTtsRes = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_API_KEY}` },
            body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: commentary, voice: req.body.openaiVoice || 'onyx', instructions: 'Voz de narrador de arena: madura, grave e animada.', response_format: 'mp3' }),
          });
          if (openaiTtsRes.ok) {
            ttsBuffer = Buffer.from(await openaiTtsRes.arrayBuffer());
            console.log('🔊 TTS: OpenAI (plano B)');
          } else {
            console.error('OpenAI TTS também falhou:', await openaiTtsRes.text());
          }
        } catch (oaiErr) {
          console.error('OpenAI TTS erro:', oaiErr.message);
        }
      }
    }
    if (!ttsBuffer) return res.status(502).json({ error: 'All TTS providers failed' });

    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Commentary-Text', encodeURIComponent(commentary));
    res.set('X-Voice-Cache', cacheHit ? 'hit' : 'miss');
    res.set('Access-Control-Expose-Headers', 'X-Commentary-Text, X-Voice-Cache');
    res.send(ttsBuffer);
  } catch (err) {
    console.error('Voice generate error:', err);
    res.status(500).json({ error: 'Internal voice error' });
  }
});

// POST /api/chat/send — Post a message to TikTok chat via connected session
app.post('/api/chat/send', async (req, res) => {
  const { message, room } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const session = getSession(room);
  if (!session?.connection) return res.status(400).json({ error: 'No TikTok connection' });
  try {
    await session.connection.sendMessage(message);
    res.json({ ok: true });
  } catch (err) {
    console.error('Chat send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== Rate Limiting: Token Bucket =====
class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.last = Date.now();
    this.dropped = 0;
  }
  take() {
    const elapsed = (Date.now() - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = Date.now();
    if (this.tokens >= 1) { this.tokens--; return true; }
    this.dropped++;
    return false;
  }
}

// Per-event-type rate limits
const RATE_LIMITS = {
  member: new TokenBucket(8, 4),    // Burst 8, sustain 4/detik
  chat:   new TokenBucket(20, 12),  // Burst 20, sustain 12/detik
  like:   new TokenBucket(4, 2),    // Burst 4, sustain 2/detik (likes are spam)
  gift:   new TokenBucket(30, 15),  // Burst 30, sustain 15/detik (gift = penting, jangan drop)
  follow: new TokenBucket(10, 5),   // Burst 10, sustain 5/detik
  share:  new TokenBucket(6, 3),    // Burst 6, sustain 3/detik
};

// ===== TikTok Connection (scoped to session) =====
function connectToTikTok(session) {
  // Set EulerStream API key if available (required for signing)
  if (process.env.EULER_API_KEY) {
    SignConfig.apiKey = process.env.EULER_API_KEY;
  }

  const username = session.username;
  const connectionOpts = {
    enableExtendedGiftInfo: false,  // Disabled — causes silent failures (Chat-Reader fix)
    processInitialData: true,       // Ambil replay events (termasuk viewer yang sudah ada)
    fetchRoomInfoOnConnect: false,  // Skip extra room info fetch — causes includes error on API response
  };
  // Add session credentials for sendMessage support (if available)
  if (process.env.TIKTOK_SESSION_ID) connectionOpts.sessionId = process.env.TIKTOK_SESSION_ID;
  if (process.env.TIKTOK_TARGET_IDC) connectionOpts.ttTargetIdc = process.env.TIKTOK_TARGET_IDC;
  const connection = new TikTokLiveConnection(username, connectionOpts);
  session.connection = connection;

  // Reconnect config
  let reconnectEnabled = true;
  let reconnectCount = 0;
  const maxReconnectAttempts = 5;
  let reconnectWaitMs = 2000;

  function scheduleReconnect(reason) {
    if (!reconnectEnabled) return;
    if (reconnectCount >= maxReconnectAttempts) {
      console.error(`❌ Max reconnect attempts (${maxReconnectAttempts}) reached for @${username}`);
      session.connectionState = { connected: false, roomId: null, error: `Reconnect failed: ${reason}` };
      emitToRoom('connection-status', session.connectionState);
      return;
    }
    reconnectWaitMs = Math.min(reconnectWaitMs * 2, 30000); // Cap at 30s
    reconnectCount++;
    console.log(`🔄 Reconnecting to @${username} in ${reconnectWaitMs}ms (attempt ${reconnectCount}/${maxReconnectAttempts})...`);
    setTimeout(() => {
      connection.connect().then(state => {
        console.log(`✅ Reconnected to @${username} (Room ID: ${state.roomId})`);
        reconnectCount = 0;
        reconnectWaitMs = 2000;
        session.connectionState = { connected: true, roomId: state.roomId, error: null };
        emitToRoom('connection-status', session.connectionState);
      }).catch(err => {
        console.error(`❌ Reconnect failed for @${username}:`, err.message);
        scheduleReconnect(err.message);
      });
    }, reconnectWaitMs);
  }

  // Langsung proses events (jangan drop replay events — viewer yang sudah ada perlu ditangkap)
  let connectionReadyAt = Date.now();

  connection.connect().then(state => {
    console.log(`✅ Connected to @${username} (Room ID: ${state.roomId})`);
    reconnectCount = 0;
    reconnectWaitMs = 2000;
    session.connectionState = { connected: true, roomId: state.roomId, error: null };
    emitToRoom('connection-status', session.connectionState);
  }).catch(err => {
    console.error('❌ Connection failed for @' + username + ':', err.message);
    session.connectionState = { connected: false, roomId: null, error: err.message };
    emitToRoom('connection-status', session.connectionState);
    scheduleReconnect(err.message);
  });

  // Handle disconnect — auto reconnect
  connection.on('disconnected', ({ code, reason }) => {
    console.log(`⚠️ Disconnected from @${username}: code=${code} reason=${reason}`);
    session.connectionState = { connected: false, roomId: null, error: reason || 'Disconnected' };
    emitToRoom('connection-status', session.connectionState);
    scheduleReconnect(reason || 'disconnected');
  });

  // Handle stream end — don't reconnect
  connection.on('streamEnd', () => {
    console.log(`📺 Stream ended for @${username}`);
    reconnectEnabled = false;
    session.connectionState = { connected: false, roomId: null, error: 'Stream ended' };
    emitToRoom('connection-status', session.connectionState);
  });

  // Handle errors — don't crash, just log
  connection.on('error', (err) => {
    console.error(`⚠️ TikTok error for @${username}:`, err.info || err.exception || err);
  });

  function isLiveEvent() {
    return Date.now() >= connectionReadyAt;
  }

  function extractUser(data) {
    const user = data.user || data;
    const profilePic = user.profilePicture?.url?.[0]
      || user.profilePicture?.urls?.[0]
      || user.profilePictureUrl
      || data.profilePictureUrl  // top-level fallback (some TikTok connector versions)
      || user.avatarThumb?.url?.[0]
      || user.avatarThumb?.urls?.[0]
      || user.avatarMedium?.url?.[0]
      || data.avatarThumb?.url?.[0]  // top-level avatar fallback
      || user.avatar_thumb?.url_list?.[0]
      || user.avatarUrl
      || data.avatarUrl
      || '';
    if (profilePic) console.log(`📷 ${user.uniqueId || user.nickname} pic: ${profilePic.slice(0, 60)}...`);
    return {
      id: (user.userId || user.uniqueId || '')?.toString(),
      uniqueId: user.uniqueId || '',
      nickname: user.nickname || user.uniqueId || 'Unknown',
      profilePic,
      isFollower: (user.followRole || 0) >= 1,
      isModerator: user.isModerator || false,
    };
  }

  const MAX_VIEWERS = 2000;

  function trackViewer(user) {
    if (!user.id) return;
    const existing = session.viewers.get(user.id);
    if (!existing) {
      // Evict oldest viewers when over limit
      if (session.viewers.size >= MAX_VIEWERS) {
        const entries = [...session.viewers.entries()];
        entries.sort((a, b) => (a[1].lastSeen || 0) - (b[1].lastSeen || 0));
        const toRemove = entries.slice(0, Math.floor(MAX_VIEWERS / 2));
        for (const [id] of toRemove) session.viewers.delete(id);
        console.log(`🧹 Evicted ${toRemove.length} stale viewers (cap: ${MAX_VIEWERS})`);
      }
      session.viewers.set(user.id, { ...user, joinedAt: Date.now(), lastSeen: Date.now() });
    } else {
      existing.lastSeen = Date.now();
    }
  }

  // Emit to session room + default room
  function emitToRoom(event, data) {
    const roomSockets = io.sockets.adapter.rooms.get(session.username);
    const defaultSockets = io.sockets.adapter.rooms.get('__default__');
    console.log(`📡 Emit ${event} to room ${session.username} (${roomSockets?.size || 0} sockets) and __default__ (${defaultSockets?.size || 0} sockets)`);
    io.to(session.username).emit(event, data);
    io.to('__default__').emit(event, data);
  }

  connection.on('member', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    if (!RATE_LIMITS.member.take()) return;  // Rate limit
    console.log(`👋 ${user.nickname} (@${user.uniqueId}) joined`);
    emitToRoom('viewer-join', { ...user, joinedAt: Date.now() });
  });

  connection.on('chat', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    if (!RATE_LIMITS.chat.take()) return;  // Rate limit
    const msg = { ...user, comment: data.comment || '', timestamp: Date.now() };
    console.log(`💬 ${msg.nickname}: ${msg.comment}`);
    emitToRoom('chat', msg);
  });

  connection.on('gift', (data) => {
    if (data.giftType === 1 && !data.repeatEnd) return;
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    if (!RATE_LIMITS.gift.take()) return;  // Rate limit
    const gift = {
      ...user,
      giftName: data.giftName || 'Gift',
      giftId: data.giftId,
      diamondCount: data.diamondCount || 0,
      repeatCount: data.repeatCount || 1,
      giftPictureUrl: data.giftPictureUrl || '',
      timestamp: Date.now(),
    };
    console.log(`🎁 ${gift.nickname} sent ${gift.repeatCount}x ${gift.giftName}`);
    emitToRoom('gift', gift);
  });

  connection.on('like', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    if (!RATE_LIMITS.like.take()) return;  // Rate limit
    emitToRoom('like', {
      ...user,
      likeCount: data.likeCount || 1,
      totalLikes: data.totalLikeCount || 0,
      timestamp: Date.now(),
    });
  });

  connection.on('follow', (data) => {
    const user = extractUser(data);
    trackViewer(user);
    if (!isLiveEvent()) return;
    if (!RATE_LIMITS.follow.take()) return;  // Rate limit
    console.log(`⭐ ${user.nickname} followed!`);
    emitToRoom('follow', { ...user, timestamp: Date.now() });
  });

  connection.on('share', (data) => {
    const user = extractUser(data);
    if (!isLiveEvent()) return;
    if (!RATE_LIMITS.share.take()) return;  // Rate limit
    emitToRoom('share', user);
  });

  connection.on('social', (data) => {
    try {
      const user = extractUser(data);
      if (!isLiveEvent()) return;
      // displayType can be at different paths depending on v2.x version
      const displayType = data.displayType
        || data.common?.displayText?.displayType
        || data.data?.displayType
        || '';
      if (typeof displayType === 'string' && displayType.includes('follow')) {
        emitToRoom('follow', { ...user, timestamp: Date.now() });
      }
      if (typeof displayType === 'string' && displayType.includes('share')) {
        emitToRoom('share', user);
      }
    } catch (e) {
      console.warn('⚠️ Social event parse error:', e.message);
    }
  });

  connection.on('roomUser', (data) => {
    emitToRoom('room-stats', { viewerCount: data.viewerCount });
    // Track top viewers dari roomUser event (viewer yang sudah ada)
    if (data.topViewers && Array.isArray(data.topViewers)) {
      const viewers = [];
      data.topViewers.forEach(tv => {
        if (tv.user) {
          const user = extractUser(tv.user);
          trackViewer(user);
          viewers.push(user);
        }
      });
      if (viewers.length > 0) {
        emitToRoom('top-viewers', viewers);
      }
    }
  });

  session.connection = connection;
  session.lastActivity = Date.now();
}

// ===== Demo Mode (scoped to session) =====
const DEMO_USERS = [
  { id: 'd1', uniqueId: 'gamer_girl99', nickname: 'GamerGirl', isFollower: true, isModerator: false },
  { id: 'd2', uniqueId: 'tech_bro_my', nickname: 'TechBro MY', isFollower: false, isModerator: false },
  { id: 'd3', uniqueId: 'todak_fan_01', nickname: 'Todak Fan', isFollower: true, isModerator: false },
  { id: 'd4', uniqueId: 'streamsniper420', nickname: 'StreamSniper', isFollower: false, isModerator: false },
  { id: 'd5', uniqueId: 'neon_rider', nickname: 'Neon Rider', isFollower: true, isModerator: true },
  { id: 'd6', uniqueId: 'kl_foodie', nickname: 'KL Foodie', isFollower: false, isModerator: false },
  { id: 'd7', uniqueId: 'cyberjaya_dev', nickname: 'CJ Dev', isFollower: true, isModerator: false },
  { id: 'd8', uniqueId: 'mrsm_alumni', nickname: 'MRSM Alumni', isFollower: true, isModerator: false },
  { id: 'd9', uniqueId: 'esports_queen', nickname: 'Esports Queen', isFollower: false, isModerator: false },
  { id: 'd10', uniqueId: 'retro_gamer_88', nickname: 'RetroGamer88', isFollower: true, isModerator: false },
  { id: 'd11', uniqueId: 'ai_enthusiast', nickname: 'AI Enthusiast', isFollower: false, isModerator: false },
  { id: 'd12', uniqueId: 'pixel_artist_my', nickname: 'PixelArtist', isFollower: true, isModerator: false },
];

const DEMO_CHATS = [
  'hello bro!', 'assalamualaikum!', 'first time here', 'nice stream!',
  'where are you from?', 'todak gaming best!', 'love from KL',
  'share share share!', 'can you play MLBB?', 'nice setup bro',
  'follow back pls', 'what game is this?', 'hahaha legend!',
  'how to join?', 'the overlay is so cool!', 'neo todak in the house!',
];

const DEMO_GIFTS = ['Rose', 'Ice Cream Cone', 'GG', 'Doughnut', 'TikTok'];

function emitToSession(session, event, data) {
  io.to(session.username).emit(event, data);
  io.to('__default__').emit(event, data);
}

function startDemo(session) {
  console.log(`🎮 Demo mode started for @${session.username}`);
  session.connectionState = { connected: true, roomId: 'DEMO-MODE', error: null };
  emitToSession(session, 'connection-status', session.connectionState);
  session.demoViewerIdx = 0;
  session.demoViewerCount = 0;
  session.demoStopped = false;
  session.demoActive = true;

  function scheduleNextJoin() {
    if (session.demoStopped || session.demoViewerIdx >= DEMO_USERS.length) return;
    const delay = 2000 + Math.random() * 3000;
    session.demoJoinTimer = setTimeout(() => {
      if (session.demoStopped) return;
      const user = DEMO_USERS[session.demoViewerIdx++];
      const viewer = { ...user, profilePic: '', joinedAt: Date.now() };
      session.viewers.set(viewer.id, viewer);
      session.demoViewerCount++;
      emitToSession(session, 'viewer-join', viewer);
      emitToSession(session, 'room-stats', { viewerCount: session.demoViewerCount });
      scheduleNextJoin();
    }, delay);
  }
  scheduleNextJoin();

  session.demoInterval = setInterval(() => {
    if (session.demoStopped) return;
    const activeViewers = Array.from(session.viewers.values());
    if (activeViewers.length === 0) return;

    const roll = Math.random();
    const user = activeViewers[Math.floor(Math.random() * activeViewers.length)];

    if (roll < 0.6) {
      const comment = DEMO_CHATS[Math.floor(Math.random() * DEMO_CHATS.length)];
      emitToSession(session, 'chat', { ...user, comment, timestamp: Date.now() });
    } else if (roll < 0.8) {
      emitToSession(session, 'like', { ...user, likeCount: Math.floor(Math.random() * 5) + 1, totalLikes: Math.floor(Math.random() * 500), timestamp: Date.now() });
    } else if (roll < 0.92) {
      const giftName = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      emitToSession(session, 'gift', { ...user, giftName, diamondCount: Math.floor(Math.random() * 100) + 1, repeatCount: Math.floor(Math.random() * 3) + 1, giftPictureUrl: '', timestamp: Date.now() });
    } else {
      emitToSession(session, 'follow', { ...user, timestamp: Date.now() });
    }
  }, 3000 + Math.random() * 3000);
}

function stopDemo(session) {
  session.demoStopped = true;
  session.demoActive = false;
  if (session.demoInterval) clearInterval(session.demoInterval);
  session.demoInterval = null;
  if (session.demoJoinTimer) clearTimeout(session.demoJoinTimer);
  session.demoJoinTimer = null;
  DEMO_USERS.forEach(u => session.viewers.delete(u.id));
  session.connectionState = { connected: false, roomId: null, error: null };
  emitToSession(session, 'connection-status', session.connectionState);
  console.log(`🛑 Demo mode stopped for @${session.username}`);
}

// ===== Bot Mode (scoped to session) =====
const BOT_USERS = [
  { id: 'bot_1', uniqueId: 'aisyah_kl', nickname: 'Aisyah', isFollower: true, isModerator: false },
  { id: 'bot_2', uniqueId: 'haziq_gaming', nickname: 'Haziq', isFollower: false, isModerator: false },
  { id: 'bot_3', uniqueId: 'mei_ling88', nickname: 'Mei Ling', isFollower: true, isModerator: false },
  { id: 'bot_4', uniqueId: 'arjun_plays', nickname: 'Arjun', isFollower: false, isModerator: false },
  { id: 'bot_5', uniqueId: 'nurul_amira', nickname: 'Nurul', isFollower: true, isModerator: false },
  { id: 'bot_6', uniqueId: 'tanaka_yuki', nickname: 'Yuki', isFollower: false, isModerator: false },
  { id: 'bot_7', uniqueId: 'danish_my', nickname: 'Danish', isFollower: true, isModerator: false },
  { id: 'bot_8', uniqueId: 'siti_sarah', nickname: 'Siti Sarah', isFollower: true, isModerator: false },
];

const BOT_CHATS = [
  'lets go!', 'woooo!', 'nice!', 'hahaha', 'gg bro',
  'so cool!', 'faster faster!', 'nooo obstacle!', 'love this game',
  'gogogogo!', 'semangat!', 'bestnya!', 'I\'m winning!',
  'wahh pro!', 'lajunyaaa', 'sikit lagi!', 'terbaik bro!',
];

const BOT_COMMANDS = ['jump', 'left', 'right'];

function startBots(session) {
  if (session.botsActive) return;
  session.botsActive = true;
  session.botJoinIdx = 0;
  console.log(`🤖 Bot mode started for @${session.username}`);

  function scheduleNextBot() {
    if (!session.botsActive || session.botJoinIdx >= BOT_USERS.length) return;
    const delay = 1000 + Math.random() * 2000;
    session.botJoinTimer = setTimeout(() => {
      if (!session.botsActive) return;
      const user = BOT_USERS[session.botJoinIdx++];
      const viewer = { ...user, profilePic: '', joinedAt: Date.now() };
      session.viewers.set(viewer.id, viewer);
      emitToSession(session, 'viewer-join', viewer);
      scheduleNextBot();
    }, delay);
  }
  scheduleNextBot();

  session.botInterval = setInterval(() => {
    if (!session.botsActive) return;
    const bots = BOT_USERS.filter(b => session.viewers.has(b.id));
    if (bots.length === 0) return;

    const bot = bots[Math.floor(Math.random() * bots.length)];
    const roll = Math.random();

    if (roll < 0.5) {
      const comment = BOT_CHATS[Math.floor(Math.random() * BOT_CHATS.length)];
      emitToSession(session, 'chat', { ...bot, profilePic: '', comment, timestamp: Date.now() });
    } else if (roll < 0.85) {
      emitToSession(session, 'like', { ...bot, profilePic: '', likeCount: Math.floor(Math.random() * 3) + 1, totalLikes: Math.floor(Math.random() * 200), timestamp: Date.now() });
    } else {
      const giftName = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      emitToSession(session, 'gift', { ...bot, profilePic: '', giftName, giftId: Date.now(), diamondCount: Math.floor(Math.random() * 50) + 1, repeatCount: 1, giftPictureUrl: '', timestamp: Date.now() });
    }
  }, 3000 + Math.random() * 3000);

  session.botActionInterval = setInterval(() => {
    if (!session.botsActive) return;
    const bots = BOT_USERS.filter(b => session.viewers.has(b.id));
    if (bots.length === 0) return;

    const actCount = 1 + Math.floor(Math.random() * Math.min(3, bots.length));
    const shuffled = bots.sort(() => Math.random() - 0.5);
    for (let i = 0; i < actCount; i++) {
      const bot = shuffled[i];
      const cmd = BOT_COMMANDS[Math.floor(Math.random() * BOT_COMMANDS.length)];
      emitToSession(session, 'chat', { ...bot, profilePic: '', comment: cmd, timestamp: Date.now() });
    }
  }, 1000 + Math.random() * 1000);
}

function stopBots(session) {
  session.botsActive = false;
  if (session.botInterval) clearInterval(session.botInterval);
  session.botInterval = null;
  if (session.botActionInterval) clearInterval(session.botActionInterval);
  session.botActionInterval = null;
  if (session.botJoinTimer) clearTimeout(session.botJoinTimer);
  session.botJoinTimer = null;
  BOT_USERS.forEach(b => session.viewers.delete(b.id));
  emitToSession(session, 'bots-removed', BOT_USERS.map(b => b.id));
  console.log(`🛑 Bots removed for @${session.username}`);
}

// ===== Socket.IO connection handling =====
io.on('connection', (socket) => {
  // Read room from handshake query
  const room = socket.handshake.query.room || '';
  const socketRoom = room || '__default__';
  socket.join(socketRoom);
  console.log(`🔌 Client connected (room: ${socketRoom})`);

  // Find session for this room
  const session = sessions.get(room) || sessions.get('__default__');

  // Send current state for the session
  if (session) {
    socket.emit('connection-status', session.connectionState);
    socket.emit('viewer-list', Array.from(session.viewers.values()));
  } else {
    socket.emit('connection-status', { connected: false, roomId: null, error: null });
    socket.emit('viewer-list', []);
  }

  // Connect to TikTok (requires PIN for multi-host, or works freely in single-host)
  socket.on('connect-tiktok', (data) => {
    // data can be string (old: username) or object (new: { username, pin, room })
    let targetUsername, pin, targetRoom;
    if (typeof data === 'object' && data !== null) {
      targetUsername = data.username;
      pin = data.pin;
      targetRoom = data.room;
    } else {
      targetUsername = data;
      targetRoom = room;
    }

    // Find or validate session
    let sess = sessions.get(targetRoom);
    if (!sess) {
      // Validate PIN before creating new session
      const validPin = !ACCESS_PIN && Object.keys(HOST_PINS).length === 0 // no auth needed
        || (ACCESS_PIN && pin === ACCESS_PIN) // access PIN matches
        || HOST_PINS[pin]; // host PIN matches
      if (!validPin) {
        io.to(socket.id).emit('tiktok-error', { message: 'Invalid PIN — cannot create session' });
        return;
      }
      const effectiveUsername = targetUsername || USERNAME;
      sess = new StreamSession(effectiveUsername, pin, targetUsername || 'Host');
      sessions.set(effectiveUsername, sess);
      if (!targetRoom) sessions.set('__default__', sess);
      socket.join(effectiveUsername);
      console.log(`🏠 New session: @${effectiveUsername} (access mode)`);
    }

    stopDemo(sess);
    stopBots(sess);
    if (sess.connection) {
      try { sess.connection.disconnect(); } catch (e) { /* ignore */ }
    }
    sess.viewers.clear();
    connectToTikTok(sess);
  });

  // Demo mode (scoped to session)
  socket.on('start-demo', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    let sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (!sess) {
      sess = new StreamSession(targetRoom || USERNAME, '', 'Host');
      sessions.set(sess.username, sess);
      sessions.set('__default__', sess);
      socket.join(sess.username);
    }
    stopDemo(sess);
    stopBots(sess);
    if (sess.connection) {
      try { sess.connection.disconnect(); } catch (e) { /* ignore */ }
      sess.connection = null;
    }
    sess.viewers.clear();
    startDemo(sess);
  });

  socket.on('stop-demo', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    const sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (sess) stopDemo(sess);
  });

  socket.on('start-bots', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    const sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (sess) startBots(sess);
  });

  socket.on('stop-bots', (data) => {
    const targetRoom = (typeof data === 'object' && data?.room) ? data.room : room;
    const sess = sessions.get(targetRoom) || sessions.get('__default__');
    if (sess) stopBots(sess);
  });

  // Host dashboard commands — scoped to room
  socket.on('host-command', (cmd) => {
    console.log(`🎛️ Host command (${socketRoom}): ${cmd.action}`, cmd.data || '');
    io.to(socketRoom).emit('host-command', cmd);
    if (socketRoom !== '__default__') {
      io.to('__default__').emit('host-command', cmd);
    }
  });

  // State sync — host broadcasts positions/mounts to room
  socket.on('state-sync', (state) => {
    socket.to(socketRoom).emit('state-sync', state);
    if (socketRoom !== '__default__') {
      socket.to('__default__').emit('state-sync', state);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected (room: ${socketRoom})`);
  });
});

// Inicia o servidor
Promise.resolve().then(() => {
server.listen(PORT, '0.0.0.0', () => {
  const pinCount = Object.keys(HOST_PINS).length;
  console.log(`
╔══════════════════════════════════════════════╗
║   TikTok Live Multi-Host Server              ║
║──────────────────────────────────────────────║
║   Dashboard:  http://localhost:${PORT}            ║
║   Overlay:    http://localhost:${PORT}/overlay     ║
║   Voice AI:   http://localhost:${PORT}/voice       ║
║   Username:   @${USERNAME.padEnd(28)}║
║──────────────────────────────────────────────║
║   EulerStream: ${process.env.EULER_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}                 ║
║   Voice AI:    ${((LLM_PROVIDER === 'anthropic' && ANTHROPIC_API_KEY) || (LLM_PROVIDER !== 'anthropic' && OPENAI_API_KEY)) && ELEVENLABS_API_KEY ? 'Configured ✅' : 'NOT SET ❌'}                 ║
║   Host PINs:   ${pinCount > 0 ? `${pinCount} configured ✅` : 'None (single-host) ⚠️'}             ║
║   Auto-Connect: ${AUTO_CONNECT ? 'Enabled ✅' : 'Disabled ❌'}                ║
╚══════════════════════════════════════════════╝
  `);
});
// Auto-connect to TikTok Live if enabled
if (AUTO_CONNECT && USERNAME) {
  console.log(`\n🔄 Auto-connecting to @${USERNAME}...`);
  // Create a default session and connect
  const defaultSession = new StreamSession(USERNAME, '', 'Auto');
  sessions.set(USERNAME, defaultSession);
  connectToTikTok(defaultSession);
}

}); // end start
