// 闇のつり上げオークション ONLINE ─ サーバー（ゲームの正解はすべてここが持つ）
// 起動: node server.js  →  http://localhost:3000
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// index.html だけを配信（server.js 自体は配信しない）
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

/* ========== 定数・データ ========== */
const TURN_MS = 10000;            // 1手番の持ち時間（10秒）
const START_CHIPS = 150, MAX_ROUND = 10;
const ADJ = ['呪われた','黄金の','血塗られた','ニセモノの','伝説の','錆びついた','光り輝く','禁断の','古代の','泣いている','笑う','闇夜の','深海の','幻の','持ち主を選ぶ','王家の','毒々しい','眠れる'];
const NOUN = {
  art: [['ハニワ','🗿'],['壺','🏺'],['肖像画','🖼️'],['ダイヤ','💎'],['仮面','🎭'],['彫刻','🗽']],
  rel: [['石板','🪨'],['聖杯','🏆'],['ミイラの指','☝️'],['古文書','📜'],['王冠','👑']],
  jun: [['空き缶','🥫'],['壊れた時計','⏰'],['片方の靴','👟'],['ガラクタ箱','📦'],['古びた人形','🪆']]
};
const ATTR = { art: '美術品', rel: '遺物', jun: 'ジャンク' };
const TAG_N = { launder: '💸 マネロン成功', fake: '🎭 偽物発覚', stolen: '📦 盗品（通常）' };
const CARD_N = { ladder: 'ハシゴ外し', big: '一世一代の吊り上げ', peek: '裏の顔（鑑定）', block: '闇のブロック' };
const ART = [0, 15, 40, 80, 150], REL = [0, -20, 50, 120];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = a => a[Math.floor(Math.random() * a.length)];
const draw = () => pick(['ladder', 'big', 'peek', 'block']);
const drawTag = () => { const x = Math.random(); return x < .25 ? 'launder' : x < .5 ? 'fake' : 'stolen'; };
function mkItem() {
  const k = pick(['art', 'rel', 'jun']); const [n, e] = pick(NOUN[k]);
  return { k, name: pick(ADJ) + n, em: e, base: rnd(5, 40), tag: drawTag() };
}

/* ========== 部屋管理 ========== */
const rooms = new Map();
let waiting = null, seq = 1;

function newRoom() {
  const room = { id: 'room' + (seq++), players: [], started: false, dead: false, logs: [], g: null, R: null, fxT: null };
  rooms.set(room.id, room);
  return room;
}
const seatOf = (room, sid) => room.players.findIndex(p => p.sid === sid);
const names = room => room.players.map(p => p.name);
const nm = (room, i) => room.players[i].name;

function destroyRoom(room) {
  room.dead = true;
  if (room.R) clearTimeout(room.R.timer);
  clearTimeout(room.fxT);
  rooms.delete(room.id);
  if (waiting === room) waiting = null;
}

/* ========== 送信ヘルパー ========== */
function log(room, text, cls = 'sys', seat = null) {
  const l = { text, cls, seat };
  room.logs.push(l); if (room.logs.length > 300) room.logs.shift();
  io.to(room.id).emit('log', l);
}
function fx(room, o) {                       // 演出：2秒後にサーバーが「消去」命令を送る
  clearTimeout(room.fxT);
  io.to(room.id).emit('fx', o);
  room.fxT = setTimeout(() => io.to(room.id).emit('fxclear'), 2000);
}
function fxClear(room) { clearTimeout(room.fxT); io.to(room.id).emit('fxclear'); }
const sfx = (room, k) => io.to(room.id).emit('sfx', k);

function emitState(room) {                   // 全員に同じ「公開情報」だけを送る（真の価値・タグ・手札は含めない）
  const g = room.g, R = room.R;
  io.to(room.id).emit('state', {
    round: g.round, price: R.price,
    stack: R.stack.map(x => ({ w: x.w, p: x.p })),
    active: R.active, cur: R.cur,
    mode: R.phase === 'turn' ? R.mode : null,
    deadline: R.phase === 'turn' ? R.deadline : 0,
    now: Date.now(),
    chips: g.chips,
    inv: g.inv.map(v => v.map(x => ({ k: x.k, name: x.name, em: x.em, fake: !!x.fake }))),
    hands: g.hands.map(h => h.length),
    item: { k: R.it.k, name: R.it.name, em: R.it.em },
    names: names(room), conn: room.players.map(p => p.connected), over: g.over
  });
}
function emitHand(room, seat) {              // 手札は本人のソケットにだけ送る
  const p = room.players[seat];
  if (p && p.connected) io.to(p.sid).emit('hand', room.g.hands[seat]);
}

/* ========== ゲームロジック ========== */
const topBid = R => R.stack.length ? R.stack[R.stack.length - 1] : null;
function nextActive(R, f) { for (let k = 1; k < 3; k++) { const j = (f + k) % 3; if (R.active[j]) return j; } return -1; }
function score(inv, all) {
  const c = { art: 0, rel: 0, jun: 0 }; let base = 0;
  inv.forEach(i => { c[i.k]++; base += i.base; });
  const art = ART[Math.min(c.art, 4)], rel = REL[Math.min(c.rel, 3)];
  const mx = Math.max(...all.map(v => v.filter(i => i.k === 'jun').length));
  const jb = c.jun > 0 && c.jun === mx ? 50 : 0, jun = c.jun * 5 + jb;
  return { art, rel, jun, jb, base, c, total: art + rel + jun + base };
}
function canUse(room, seat, c, mode) {
  const g = room.g, R = room.R, t = topBid(R);
  if (c === 'ladder') return !!t && t.w === seat && g.chips[seat] > 5 && (mode === 'wait' || mode === 'closing');
  if (c === 'big') return mode === 'normal' && g.chips[seat] >= R.price + 30;
  if (c === 'block') return mode === 'normal' || mode === 'wait';
  return false;
}
function removeCard(hand, c) { const i = hand.indexOf(c); if (i >= 0) hand.splice(i, 1); }

function checkBR(room) {
  const g = room.g; if (g.over) return;
  for (let i = 0; i < 3; i++) {
    if (g.chips[i] <= 0) {
      g.over = true; g.bk = i;
      log(room, `💀 ${nm(room, i)}のチップが0枚…破産！ゲーム強制終了`, 'sys');
      fx(room, { text: '💀 破産！', color: '#ff2a5f', snd: 'boom', em: '💀', shake: 1, sub: `${nm(room, i)}のチップが尽きた` });
      return;
    }
  }
}

async function startRound(room) {
  const g = room.g; g.round++;
  if (g.round > 1) for (let i = 0; i < 3; i++) { if (g.hands[i].length < 5) g.hands[i].push(draw()); emitHand(room, i); }
  fxClear(room);
  const it = mkItem();
  room.R = { it, price: 10, stack: [], active: [1, 1, 1], skip: [0, 0, 0], turn: (g.round - 1) % 3, cur: -1, mode: null, phase: 'busy', deadline: 0, timer: null };
  log(room, `━━ ラウンド${g.round}／${MAX_ROUND} ：「${it.name}」（${ATTR[it.k]}）が出品 ━━`, 'rd');
  if (g.round > 1) log(room, '全員に手札が1枚補充された（最大5枚）', 'sys');
  log(room, `${nm(room, room.R.turn)}から時計回りに競りスタート。開始価格10枚`, 'sys');
  emitState(room);
  await sleep(1200);
  if (room.dead) return;
  beginTurn(room);
}

function nextActor(room) {
  const R = room.R, act = R.active.filter(Boolean).length, top = topBid(R);
  if (act === 0) return { resolve: top ? top.w : -1 };
  if (act === 1) {
    const a = R.active.indexOf(1);
    if (!top || top.w === a) { R.skip[a] = 0; return { t: a, mode: top ? 'closing' : 'closingNoStack' }; }
  }
  for (let guard = 0; guard < 12; guard++) {
    const t = R.turn;
    if (!R.active[t]) { R.turn = (t + 1) % 3; continue; }
    if (R.skip[t]) { R.skip[t] = 0; log(room, `${nm(room, t)}は手番を飛ばされた！`, 'sys'); R.turn = (t + 1) % 3; continue; }
    return { t, mode: top && top.w === t ? 'wait' : 'normal' };
  }
  return { resolve: top ? top.w : -1 };
}

function beginTurn(room) {
  if (room.dead || room.g.over) return;
  const R = room.R;
  const n = nextActor(room);
  if (n.resolve !== undefined) return void resolveAuction(room, n.resolve);
  fxClear(room);
  R.cur = n.t; R.mode = n.mode; R.phase = 'turn';
  const p = room.players[n.t];
  const ms = p.connected ? TURN_MS : 1500;      // 切断中の人は短時間で自動進行
  R.deadline = Date.now() + ms;
  emitState(room);
  clearTimeout(R.timer);
  R.timer = setTimeout(() => autoAct(room, n.t), ms);
}

function autoAct(room, t) {
  const R = room.R;
  if (room.dead || !R || R.phase !== 'turn' || R.cur !== t) return;
  const m = R.mode;
  const a = m === 'normal' ? { t: 'pass' } : m === 'wait' ? { t: 'wait' } : m === 'closing' ? { t: 'confirm' } : { t: 'pass' };
  if (room.players[t].connected) log(room, `⏱ ${nm(room, t)}は時間切れ！（自動で「${a.t === 'pass' ? 'パス' : a.t === 'wait' ? '様子見' : '落札確定'}」）`, 'sys');
  handleAction(room, t, a);
}

function handleAction(room, seat, a) {
  const g = room.g, R = room.R;
  if (!R || R.phase !== 'turn' || R.cur !== seat || g.over) return false;
  const mode = R.mode;
  let ok = false;
  if (a.t === 'raise') ok = mode === 'normal' && g.chips[seat] >= R.price + 5;
  else if (a.t === 'pass') ok = mode === 'normal' || mode === 'closingNoStack';
  else if (a.t === 'wait') ok = mode === 'wait';
  else if (a.t === 'confirm') ok = mode === 'closing' || mode === 'closingNoStack';
  else if (a.t === 'card') ok = typeof a.c === 'string' && g.hands[seat].includes(a.c) && canUse(room, seat, a.c, mode);
  if (!ok) return false;

  clearTimeout(R.timer);
  R.phase = 'busy'; R.mode = null;
  if (a.t === 'confirm') { resolveAuction(room, seat); return true; }

  let delay = 600;
  if (a.t === 'raise') {
    R.price += 5; R.stack.push({ w: seat, p: R.price });
    log(room, `${nm(room, seat)}が入札！ → ${R.price}枚`, 'b', seat); sfx(room, 'bid');
  } else if (a.t === 'pass') {
    R.active[seat] = 0;
    log(room, `${nm(room, seat)}がパス（ハシゴを降りた）`, 'p', seat); sfx(room, 'pass');
  } else if (a.t === 'wait') {
    log(room, `${nm(room, seat)}は様子見…`, 'sys');
  } else if (a.t === 'card') {
    const c = a.c; delay = 1700;
    removeCard(g.hands[seat], c); emitHand(room, seat);
    log(room, `${nm(room, seat)}がカード「${CARD_N[c]}」を使った！`, 'c', seat);
    if (c === 'ladder') {
      g.chips[seat] -= 5; R.stack.pop();
      R.price = R.stack.length ? topBid(R).p : 10; R.active[seat] = 0;
      fx(room, { text: '💥 ハシゴ外し！', color: '#ff2a5f', snd: 'boom', em: '💥', shake: 1, sub: `${nm(room, seat)}が入札を取り消した` });
      log(room, `　→ ${nm(room, seat)}は違約金5枚を払って入札を取り消し、降りた。価格は${R.price}枚に戻る`, 'p', seat);
      const n = topBid(R); if (n) log(room, `　→ 最高入札は${nm(room, n.w)}の${n.p}枚に！`, 'sys');
    } else if (c === 'big') {
      R.price += 30; R.stack.push({ w: seat, p: R.price });
      fx(room, { text: '🔥 一世一代！ +30', color: '#ffd700', snd: 'big', em: '🔥', sub: `${nm(room, seat)}が価格を吊り上げた` });
      log(room, `　→ 価格が一気に${R.price}枚に！`, 'b', seat);
    } else if (c === 'block') {
      const n = nextActive(R, seat);
      if (n >= 0) { R.skip[n] = 1; log(room, `　→ ${nm(room, n)}の次の手番を飛ばす`, 'sys'); }
      fx(room, { text: '⛓️ 闇のブロック', color: '#b26bff', snd: 'block', em: '⛓️', sub: n >= 0 ? `${nm(room, n)}は次の手番を飛ばされる` : '' });
    }
  }
  checkBR(room);
  emitState(room);
  R.turn = (seat + 1) % 3;
  if (g.over) setTimeout(() => gameOver(room), 1800);
  else setTimeout(() => beginTurn(room), delay);
  return true;
}

async function resolveAuction(room, w) {
  const g = room.g, R = room.R;
  clearTimeout(R.timer); R.phase = 'busy'; R.mode = null; R.cur = -1;
  fxClear(room);
  if (w < 0) {
    log(room, '🔨 誰も落札せず、流れた…', 'sys'); emitState(room);
    await sleep(1300); return finishRound(room);
  }
  const it = { ...R.it };
  const pay = Math.min(R.price, g.chips[w]);
  g.chips[w] -= pay;
  log(room, `🔨 ${nm(room, w)}が${pay}枚で「${it.name}」を落札！`, 'win');
  emitState(room);
  fx(room, { text: 'SOLD！', color: '#ffd700', snd: 'win', em: '✨', sub: `${nm(room, w)}が${pay}枚で落札` });
  await sleep(1800); if (room.dead) return;
  fxClear(room);

  // 闇の査定員タグ公開
  log(room, `🕶 闇の査定員タグ公開：${TAG_N[it.tag]}（真の価値 +${it.base}pt）`, 'tag');
  if (it.tag === 'fake') {
    it.k = 'jun'; it.fake = true;
    log(room, `　→ 偽物だった！「${it.name}」はジャンク（5pt）に劣化`, 'tag');
    fx(room, { text: '🎭 偽物発覚！', color: '#ff2a5f', snd: 'boom', em: '💨', shake: 1, sub: '属性がジャンクに劣化' });
  } else if (it.tag === 'launder') {
    const cb = Math.floor(pay * .3); g.chips[w] += cb;
    log(room, `　→ マネロン成功！ ${nm(room, w)}に${cb}枚キャッシュバック`, 'tag');
    fx(room, { text: `💸 マネロン成功！ +${cb}`, color: '#00ffcc', snd: 'coin', em: '💸', sub: `${nm(room, w)}に30%が戻った` });
  } else {
    fx(room, { text: '📦 盗品（通常）', color: '#ffd700', snd: null, em: '', sub: '特殊効果なし' });
  }
  g.inv[w].push(it);
  checkBR(room);
  emitState(room);
  await sleep(1800); if (room.dead) return;
  fxClear(room);
  finishRound(room);
}

async function finishRound(room) {
  if (room.dead) return;
  const g = room.g;
  if (g.over) { await sleep(1800); return gameOver(room); }
  if (g.round >= MAX_ROUND) return gameOver(room);
  startRound(room);
}

function gameOver(room) {
  if (room.dead || room.g.finished) return;
  const g = room.g;
  g.finished = true; g.over = true;
  if (room.R) { clearTimeout(room.R.timer); room.R.phase = 'busy'; room.R.mode = null; room.R.cur = -1; emitState(room); }
  fxClear(room);
  const results = [0, 1, 2].map(i => {
    const s = score(g.inv[i], g.inv), pen = g.inv[i].length <= 2 ? 100 : 0;
    return {
      seat: i, name: nm(room, i), chips: g.chips[i], art: s.art, rel: s.rel, jun: s.jun, jb: s.jb, base: s.base, c: s.c, pen,
      total: g.chips[i] + s.total - pen,
      items: g.inv[i].map(x => ({ em: x.em, name: x.name, fake: !!x.fake }))
    };
  });
  io.to(room.id).emit('over', { results, bk: g.bk });
  setTimeout(() => destroyRoom(room), 10 * 60 * 1000);
}

function startGame(room) {
  if (room.dead) return;
  room.g = {
    chips: [START_CHIPS, START_CHIPS, START_CHIPS], inv: [[], [], []],
    hands: [[draw(), draw(), draw()], [draw(), draw(), draw()], [draw(), draw(), draw()]],
    round: 0, over: false, bk: -1, finished: false
  };
  room.players.forEach((p, i) => { io.to(p.sid).emit('start', { seat: i, names: names(room) }); });
  for (let i = 0; i < 3; i++) emitHand(room, i);
  log(room, '3人が揃った！開幕。全員150枚・手札3枚。全10ラウンド！', 'sys');
  startRound(room);
}

/* ========== 通信（Socket.io） ========== */
function rejoin(sock, room, p) {
  p.sid = sock.id; p.connected = true;
  sock.join(room.id); sock.data.room = room;
  sock.emit('joined', { token: p.token });
  if (!room.started) {
    io.to(room.id).emit('queue', { count: room.players.length, need: 3, names: names(room) });
    return;
  }
  const seat = seatOf(room, sock.id);
  sock.emit('start', { seat, names: names(room) });
  sock.emit('logs', room.logs);
  emitHand(room, seat);
  if (room.R) emitState(room);
  log(room, `${p.name}が再接続した`, 'sys');
}

io.on('connection', sock => {
  sock.data = {};

  sock.on('join', d => {
    d = d || {};
    const token = typeof d.token === 'string' && d.token.length > 0 && d.token.length < 64 ? d.token : null;
    const name = String(d.name || '').replace(/[<>&"'`]/g, '').trim().slice(0, 10) || 'プレイヤー';

    if (token) {                                   // 再接続（リロード・回線切れ復帰）
      for (const r of rooms.values()) {
        if (r.dead || (r.g && r.g.finished)) continue;
        const p = r.players.find(x => x.token === token);
        if (p) return rejoin(sock, r, p);
      }
    }
    if (d.rejoinOnly) return sock.emit('lobby');

    // 新規マッチング
    let room = waiting;
    if (!room || room.started || room.dead || room.players.length >= 3) { room = newRoom(); waiting = room; }
    const tk = token || crypto.randomBytes(12).toString('hex');
    room.players.push({ sid: sock.id, token: tk, name, connected: true });
    sock.join(room.id); sock.data.room = room;
    sock.emit('joined', { token: tk });
    io.to(room.id).emit('queue', { count: room.players.length, need: 3, names: names(room) });
    if (room.players.length === 3) {
      room.started = true; waiting = null;
      setTimeout(() => startGame(room), 1500);
    }
  });

  // 入札・パス・様子見・落札確定・カード使用
  sock.on('action', a => {
    const room = sock.data.room; if (!room || room.dead || !room.started || !a || typeof a !== 'object') return;
    const seat = seatOf(room, sock.id); if (seat < 0) return;
    if (!handleAction(room, seat, { t: String(a.t), c: a.c })) {
      sock.emit('errmsg', 'その操作は今はできません');
      if (room.R) emitState(room);      // 画面とサーバーの状態を再同期
    }
  });

  // 「裏の顔」：手番を消費しない。結果は本人のソケットにだけ送る
  sock.on('peek', () => {
    const room = sock.data.room; if (!room || room.dead || !room.started) return;
    const seat = seatOf(room, sock.id), g = room.g, R = room.R;
    if (seat < 0 || !R || R.phase !== 'turn' || R.cur !== seat || !g.hands[seat].includes('peek')) return;
    removeCard(g.hands[seat], 'peek'); emitHand(room, seat);
    log(room, `${nm(room, seat)}が「裏の顔」を使い、お宝の真価を覗き見た！`, 'c', seat);
    io.to(sock.id).emit('peek', { base: R.it.base, tag: R.it.tag, ms: 3000 });
    sfx(room, 'peek');
  });

  sock.on('disconnect', () => {
    const room = sock.data.room; if (!room || room.dead) return;
    const seat = seatOf(room, sock.id); if (seat < 0) return;
    if (!room.started) {                           // 待機中なら席を空ける
      room.players.splice(seat, 1);
      if (!room.players.length) { destroyRoom(room); return; }
      io.to(room.id).emit('queue', { count: room.players.length, need: 3, names: names(room) });
      return;
    }
    room.players[seat].connected = false;
    if (room.players.every(p => !p.connected)) { destroyRoom(room); return; }
    log(room, `${room.players[seat].name}の接続が切れた（自動進行になります）`, 'sys');
    const R = room.R;
    if (R && R.phase === 'turn' && R.cur === seat) {
      clearTimeout(R.timer); R.deadline = Date.now() + 1500; emitState(room);
      R.timer = setTimeout(() => autoAct(room, seat), 1500);
    } else if (R) emitState(room);
  });
});

server.listen(PORT, () => console.log(`闇のオークション起動中 → http://localhost:${PORT}`));
