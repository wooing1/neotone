#!/usr/bin/env node
/*
 * NEOTONE 릴레이 서버
 *
 *   node server.js            → http://localhost:9000
 *   node server.js 8080       → 포트 지정
 *
 * 하는 일 두 가지
 *   1) index.html 을 서빙한다 (릴레이를 쓰도록 표시 하나만 끼워서)
 *   2) /ws 에서 게임 데이터를 중계한다
 *
 * 왜 필요한가
 *   원래는 브라우저끼리 WebRTC 로 직접 연결한다. 그런데 회사·학교·일부 모바일망은
 *   NAT 이 까다로워서 경로가 안 뚫리고, 그러면 아무리 기다려도 연결되지 않는다.
 *   이 서버를 거치면 각자 "바깥으로 나가는 WebSocket 하나"만 열면 되므로
 *   NAT 을 탈 일이 없다. 방화벽 설정도, 포트 포워딩도 필요 없다.
 *
 * 밖에서 접속하게 만들기 (친구가 다른 네트워크에 있을 때)
 *   cloudflared tunnel --url http://localhost:9000
 *   → https://무작위이름.trycloudflare.com 주소가 나온다. 그 주소를 공유하면 끝.
 *     (계정 없이 됩니다. 자세한 건 README 5장)
 */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2], 10) || 9000;
// 바인딩 주소. nginx 뒤에 둘 때는 127.0.0.1 로 묶어서 바깥에 직접 노출되지 않게 한다.
//   node server.js 9000 127.0.0.1
const BIND = process.argv[3] || process.env.NEOTONE_BIND || '0.0.0.0';
const MAX_PLAYERS = 4;
// 공개 서버에 올려도 견디도록 한도를 둔다 (인증 없는 릴레이라서)
const MAX_SOCKETS = parseInt(process.env.NEOTONE_MAX_SOCKETS || '64', 10);
const MAX_ROOMS   = parseInt(process.env.NEOTONE_MAX_ROOMS   || '16', 10);
let sockCount = 0;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // RFC 6455

/* ══════════════════════════════════════════════════════════
   공용 랭킹
   ══════════════════════════════════════════════════════════
   세 게임(줄넘기·탄막·자동차)이 같은 출처라 nginx 를 건드릴 필요가 없다.
   `proxy_pass http://127.0.0.1:9000/` 의 끝 슬래시가 /plane/ 접두사를 잘라내므로
   게임에서 /plane/api/rank 를 부르면 여기로 /api/rank 로 들어온다.
   (끝 슬래시가 언젠가 지워져도 안 깨지게 두 형태를 모두 받는다)

   불변식 하나: score 는 항상 정수이고 항상 클수록 좋다.
   단위가 다른 세 게임은 제출 시점에 각자 이 축으로 변환해서 보낸다. */

// 게임 화이트리스트. 이 표가 세 가지를 겸한다:
//   ① 표시 포맷(클라이언트에 게임별 코드가 0줄이 된다)
//   ② 모르는 game 키를 400 으로 거절 → 파일이 무한히 커지는 것을 막는다
//   ③ 게임별 점수 상한 (999999 같은 무성의한 위조를 거른다)
const GAMES = {
  jumprope: { label: '탭탭 줄넘기', unit: '점', max: 1000000, sub: [['combo','콤보']] },
  plane:    { label: 'NEOTONE',    unit: '점', max: 200000000, sub: [['stage','ST']] },
  race:     { label: '쌩쌩 추월',  unit: 'm',  max: 20000,     sub: [['overtakes','추월']] },
};
const KEEP = 20;                       // 게임당 보관 건수

// 데이터는 게임 코드 밖에 둔다. /opt/neotone 안에 두면 재배포 때 함께 날아갈 수 있다.
const DATA_DIR = process.env.NEOTONE_DATA || '/var/lib/neotone';
let RANK_FILE = path.join(DATA_DIR, 'ranks.json');
let ranks = { v: 1, games: { jumprope: [], plane: [], race: [] } };

(function initRanks(){
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e){
    // 어떤 경우에도 여기서 죽으면 안 된다 — 랭킹 때문에 4인 릴레이가 못 뜨면 본말전도다
    RANK_FILE = path.join(__dirname, 'ranks.json');
    console.log('  ! 랭킹 디렉터리를 만들지 못해 ' + RANK_FILE + ' 로 대체합니다: ' + e.message);
  }
  try {
    const raw = fs.readFileSync(RANK_FILE, 'utf8');
    const o = JSON.parse(raw);
    if (o && o.games) for (const g of Object.keys(ranks.games))
      if (Array.isArray(o.games[g])) ranks.games[g] = o.games[g];
  } catch (e){
    if (e.code !== 'ENOENT'){
      // 깨진 파일을 덮어쓰기 전에 옆으로 치워 둔다
      try { fs.renameSync(RANK_FILE, RANK_FILE + '.bad.' + Date.now()); } catch(e2){}
      console.log('  ! 랭킹 파일을 읽지 못해 새로 시작합니다: ' + e.message);
    }
  }
})();

// 저장은 원자적으로. 반쪽짜리 파일이 남으면 다음 부팅에서 전부 잃는다.
let saveTimer = null;
function saveRanksNow(){
  saveTimer = null;
  const tmp = RANK_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(ranks), 'utf8');
    fs.renameSync(tmp, RANK_FILE);
  } catch (e){
    console.log('  ! 랭킹 저장 실패: ' + e.message);
    try { fs.unlinkSync(tmp); } catch(e2){}
  }
}
// 연속 제출을 1초로 묶는다 (디스크 쓰기가 릴레이 루프를 방해하지 않게)
function saveRanks(){ if (!saveTimer) saveTimer = setTimeout(saveRanksNow, 1000); }
process.on('SIGTERM', () => { if (saveTimer){ clearTimeout(saveTimer); saveRanksNow(); } process.exit(0); });
process.on('SIGINT',  () => { if (saveTimer){ clearTimeout(saveTimer); saveRanksNow(); } process.exit(0); });

function cleanName(v){
  let n = String(v == null ? '' : v).normalize('NFC');
  n = n.replace(/[^\p{L}\p{N} _\-.!?]/gu, '').trim().slice(0, 8);
  return n || '익명';
}
function fmtScore(g, score){
  if (g === 'race') return score >= 1000 ? (score/1000).toFixed(2) + ' km' : score + ' m';
  return score.toLocaleString('en-US') + ' ' + GAMES[g].unit;
}
function viewEntry(g, e, i){
  const sub = [];
  for (const [k, lbl] of GAMES[g].sub)
    if (e.meta && e.meta[k] != null) sub.push(lbl + ' ' + e.meta[k]);
  return { r: i + 1, uid: e.uid, name: e.name, score: e.score,
           disp: fmtScore(g, e.score), sub: sub.join(' · '), ts: e.ts };
}
function topOf(g, n, uid){
  const list = ranks.games[g] || [];
  const out = { label: GAMES[g].label, unit: GAMES[g].unit, total: list.length,
                top: list.slice(0, n).map((e, i) => viewEntry(g, e, i)), me: null };
  if (uid){
    const i = list.findIndex(e => e.uid === uid);
    if (i >= 0) out.me = { rank: i + 1, score: list[i].score, disp: fmtScore(g, list[i].score) };
  }
  return out;
}

// 쿨다운 (도배 방지). Map 이 무한히 커지지 않게 상한을 둔다.
// 키는 uid + 게임이다 — uid 만으로 잠그면 자동차를 끝내고 3초 안에 줄넘기를 끝낸 기록이
// 조용히 사라진다 (실제로 테스트에서 그렇게 한 건을 잃었다).
const cooldown = new Map();
function tooSoon(uid){
  const now = Date.now(), last = cooldown.get(uid);
  if (last && now - last < 3000) return true;
  if (cooldown.size > 200) cooldown.clear();
  cooldown.set(uid, now);
  return false;
}

function submitRank(d){
  const g = String(d.game || '');
  if (!GAMES[g]) return { ok: false, err: 'unknown game' };
  const score = Math.round(Number(d.score));
  if (!isFinite(score) || score < 0 || score > GAMES[g].max) return { ok: false, err: 'bad score' };
  const uid = String(d.uid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'anon';
  if (tooSoon(uid + '|' + g)) return { ok: false, err: 'too soon' };

  let meta = {};
  try { const j = JSON.stringify(d.meta || {}); if (j.length <= 200) meta = JSON.parse(j); } catch(e){}

  const list = ranks.games[g];
  const name = cleanName(d.name);
  const prev = list.findIndex(e => e.uid === uid);
  let best = true;
  if (prev >= 0){
    // uid 당 1건만 둔다 — 한 명이 열 칸을 다 먹는 것도, 도배로 파일이 커지는 것도 막는다
    if (list[prev].score >= score){ list[prev].name = name; best = false; }
    else list[prev] = { uid, name, score, ts: Date.now(), meta };
  } else {
    list.push({ uid, name, score, ts: Date.now(), meta });
  }
  list.sort((a, b) => (b.score - a.score) || (a.ts - b.ts));
  if (list.length > KEEP) list.length = KEEP;
  saveRanks();

  const rank = list.findIndex(e => e.uid === uid);
  console.log('[' + new Date().toTimeString().slice(0,8) + '] ' + g + ' — ' +
              name + ' ' + fmtScore(g, score) + (rank >= 0 ? ' (' + (rank+1) + '위)' : ''));
  return { ok: true, rank: rank >= 0 ? rank + 1 : null, best, n: list.length,
           unit: GAMES[g].unit, top: list.slice(0, 10).map((e, i) => viewEntry(g, e, i)) };
}

function readBody(req, cb){
  let n = 0; const chunks = []; let done = false;
  const finish = (e, s) => { if (done) return; done = true; cb(e, s); };
  req.on('data', c => {
    n += c.length;
    if (n > 2048){ finish(new Error('too large')); try { req.destroy(); } catch(e){} return; }
    chunks.push(c);
  });
  req.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
  req.on('error', e => finish(e));
}

/* ── index.html 서빙 (릴레이 사용 표시를 끼워 넣는다) ── */
const HTML_PATH = path.join(__dirname, 'index.html');
// 매 요청마다 275KB 를 동기로 읽고 정규식까지 돌리던 것을 mtime 캐시로 바꾼다.
// 파일을 바꾸면 mtime 이 달라지므로 재시작 없이 반영된다.
let pageCache = { mtime: 0, size: -1, body: null };
function pageHtml(){
  const st = fs.statSync(HTML_PATH);
  const mt = st.mtimeMs;
  if (pageCache.body !== null && pageCache.mtime === mt && pageCache.size === st.size)
    return pageCache.body;
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  // 주의: 게임 코드 안에도 __NEOTONE_WS 라는 이름이 나온다.
  // 그래서 "이미 끼워 넣었는지"는 주입 표시 전체로 판별해야 한다.
  const flag = '<script>window.__NEOTONE_WS=1;/*neotone-relay*/</script>';
  if (!html.includes('/*neotone-relay*/'))
    html = html.replace(/<head[^>]*>/i, m => m + flag);
  pageCache = { mtime: mt, size: st.size, body: html };
  return html;
}

const server = http.createServer((req, res) => {
  if (/favicon\.ico$/.test(req.url || '')){   // 콘솔에 404 가 남지 않게
    res.writeHead(204); res.end(); return;
  }
  // 자동 플레이 / 진단 하네스 (같은 출처여야 iframe 내부를 들여다볼 수 있다)
  if (/\/autoplay(\.html)?(\?|$)/.test(req.url || '')){
    try {
      const ap = fs.readFileSync(path.join(__dirname, 'autoplay.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(ap);
    } catch (e){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('autoplay.html 을 server.js 와 같은 폴더에 두세요.\n' + e.message);
    }
    return;
  }
  // ── 공용 랭킹.  /api/rank  또는  /plane/api/rank  둘 다 받는다
  //    (nginx 가 접두사를 잘라 주지만, 그 설정이 바뀌어도 안 깨지게)
  if (/^\/(?:plane\/)?api\/rank(\?|$)/.test(req.url || '')){
    const json = (code, o) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                            'Cache-Control': 'no-store' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'POST'){
      readBody(req, (err, body) => {
        if (err) return json(413, { ok: false, err: 'too large' });
        let d; try { d = JSON.parse(body || '{}'); } catch(e){ return json(400, { ok:false, err:'bad json' }); }
        const r = submitRank(d);
        json(r.ok ? 200 : 400, r);
      });
      return;
    }
    if (req.method !== 'GET') return json(405, { ok: false, err: 'method' });
    const q = {};
    const qs = (req.url.split('?')[1] || '');
    for (const kv of qs.split('&')){
      if (!kv) continue;
      const i = kv.indexOf('=');
      const k = decodeURIComponent(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? '' : decodeURIComponent(kv.slice(i + 1));
      q[k] = v;
    }
    const n = Math.max(1, Math.min(20, parseInt(q.n, 10) || 3));
    const uid = String(q.uid || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
    if (q.game){
      if (!GAMES[q.game]) return json(400, { ok: false, err: 'unknown game' });
      return json(200, { ok: true, game: q.game, ...topOf(q.game, n, uid) });
    }
    const out = {};
    for (const g of Object.keys(GAMES)) out[g] = topOf(g, n, uid);
    return json(200, { ok: true, ts: Date.now(), games: out });
  }

  if (/\/health(\?|$)/.test(req.url || '')){
    const rc = {};
    for (const g of Object.keys(GAMES)) rc[g] = (ranks.games[g] || []).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, sockets: sockCount,
                             maxSockets: MAX_SOCKETS, maxRooms: MAX_ROOMS,
                             pid: process.pid, data: RANK_FILE, ranks: rc }));
    return;
  }
  try {
    const body = pageHtml();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (e){
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('index.html 을 찾지 못했습니다. server.js 와 같은 폴더에 두세요.\n' + e.message);
  }
});

/* ══════════════════════════════════════════════════════════
   최소 WebSocket 구현 (의존성 0개 — npm install 없이 바로 실행)
   ══════════════════════════════════════════════════════════ */
function makeFrame(payload, opcode){
  const len = payload.length;
  let head;
  if (len < 126){ head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536){ head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(len, 6); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

function Sock(socket){
  const self = {
    socket, alive: true, id: -1, room: null, isHost: false,
    onmessage: null, onclose: null,
    sendText(s){ self._send(Buffer.from(s, 'utf8'), 0x1); },
    sendBin(b){ self._send(Buffer.from(b), 0x2); },
    _send(buf, op){
      if (!self.alive) return;
      try { socket.write(makeFrame(buf, op)); } catch(e){ self.kill(); }
    },
    kill(){
      if (!self.alive) return;
      self.alive = false;
      try { socket.end(); } catch(e){}
      if (self.onclose) self.onclose();
    },
  };

  let buf = Buffer.alloc(0);
  // 조각난(fragmented) 메시지를 이어 붙이기 위한 상태
  let fragOp = 0, fragParts = [];

  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    for (;;){
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126){ if (buf.length < off + 2) return; len = buf.readUInt16BE(off); off += 2; }
      else if (len === 127){
        if (buf.length < off + 8) return;
        const hi = buf.readUInt32BE(off), lo = buf.readUInt32BE(off + 4);
        if (hi !== 0){ self.kill(); return; }            // 4GB 프레임은 받지 않는다
        len = lo; off += 8;
      }
      let mask = null;
      if (masked){ if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;

      const payload = Buffer.from(buf.slice(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.slice(off + len);

      if (opcode === 0x8){ self.kill(); return; }                     // close
      if (opcode === 0x9){ self._send(payload, 0xA); continue; }      // ping → pong
      if (opcode === 0xA) continue;                                   // pong

      if (opcode === 0x0){                                            // 이어지는 조각
        fragParts.push(payload);
        if (!fin) continue;
        const whole = Buffer.concat(fragParts);
        const op = fragOp; fragOp = 0; fragParts = [];
        if (self.onmessage) self.onmessage(whole, op === 0x1);
        continue;
      }
      if (!fin){ fragOp = opcode; fragParts = [payload]; continue; }  // 첫 조각
      if (self.onmessage) self.onmessage(payload, opcode === 0x1);
    }
  });

  socket.on('error', () => self.kill());
  socket.on('close', () => self.kill());
  return self;
}

server.on('upgrade', (req, socket) => {
  // nginx 뒤에 서브경로로 붙을 수 있다 (/neotone/ws 처럼). 끝이 /ws 면 받는다.
  if (!/\/ws(\?|$)/.test(req.url || '')){ socket.destroy(); return; }
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  if (sockCount >= MAX_SOCKETS){
    try { socket.end(); } catch(e){}
    log('접속 한도(' + MAX_SOCKETS + ')를 넘어 거절');
    return;
  }
  sockCount++;
  handle(Sock(socket));
});

/* ══════════════════════════════════════════════════════════
   방 관리 — 스타 구조 그대로 중계한다
     방장이 보낸 broadcast → 참가자 전원
     참가자가 보낸 것      → 방장에게만
   ══════════════════════════════════════════════════════════ */
const rooms = new Map();   // 방코드 → { host, clients: Map(id → sock), nextId }

function handle(sock){
  sock.onmessage = (data, isText) => {
    if (isText){
      let m; try { m = JSON.parse(data.toString('utf8')); } catch(e){ return; }
      if (m.sys === 'join'){ join(sock, m); return; }
      if (m.sys === 'drop'){ drop(sock, m.id); return; }
      if (!sock.room) return;
      route(sock, m.to, JSON.stringify.bind(null), { from: sock.id, d: m.d }, true);
      return;
    }
    if (!sock.room || data.length < 1) return;
    const to = data[0];
    const out = Buffer.from(data);   // 첫 바이트를 "받는 사람" → "보낸 사람" 으로 바꾼다
    out[0] = sock.id;
    route(sock, to === 255 ? null : to, null, out, false);
  };

  sock.onclose = () => {
    sockCount = Math.max(0, sockCount - 1);
    const r = sock.room && rooms.get(sock.room);
    if (!r) return;
    if (sock.isHost){
      r.clients.forEach(c => { c.sendText(JSON.stringify({ sys: 'close', id: sock.id })); c.kill(); });
      rooms.delete(sock.room);
      log('방 ' + sock.room + ' 닫힘 (방장 나감)');
    } else {
      r.clients.delete(sock.id);
      if (r.host) r.host.sendText(JSON.stringify({ sys: 'close', id: sock.id }));
      log('방 ' + sock.room + ' — P' + (sock.id + 1) + ' 나감 (' + (r.clients.size + 1) + '명)');
    }
  };
}

function join(sock, m){
  const code = String(m.room || '').toUpperCase().slice(0, 8);
  if (!code){ sock.sendText(JSON.stringify({ sys: 'nohost' })); return; }

  if (m.host){
    if (rooms.has(code)){ sock.sendText(JSON.stringify({ sys: 'taken' })); return; }
    if (rooms.size >= MAX_ROOMS){
      sock.sendText(JSON.stringify({ sys: 'taken' }));
      log('방 한도(' + MAX_ROOMS + ') 초과 — ' + code + ' 거절');
      return;
    }
    sock.id = 0; sock.room = code; sock.isHost = true;
    rooms.set(code, { host: sock, clients: new Map(), nextId: 1 });
    sock.sendText(JSON.stringify({ sys: 'id', id: 0, hostId: 0 }));
    log('방 ' + code + ' 열림');
    return;
  }

  const r = rooms.get(code);
  if (!r || !r.host){ sock.sendText(JSON.stringify({ sys: 'nohost' })); return; }
  if (r.clients.size >= MAX_PLAYERS - 1){ sock.sendText(JSON.stringify({ sys: 'full' })); return; }

  // 비어 있는 번호를 다시 쓴다 (나갔다 들어오면 그 자리로)
  let id = 1;
  while (id < MAX_PLAYERS && r.clients.has(id)) id++;
  sock.id = id; sock.room = code; sock.isHost = false;
  r.clients.set(id, sock);
  sock.sendText(JSON.stringify({ sys: 'id', id, hostId: 0 }));
  r.host.sendText(JSON.stringify({ sys: 'open', id }));
  log('방 ' + code + ' — P' + (id + 1) + ' 입장 (' + (r.clients.size + 1) + '명)');
}

function drop(sock, id){
  const r = sock.room && rooms.get(sock.room);
  if (!r || !sock.isHost) return;                  // 강제 퇴장은 방장만
  const c = r.clients.get(id);
  if (!c) return;
  c.sendText(JSON.stringify({ sys: 'kicked' }));
  r.clients.delete(id);
  setTimeout(() => c.kill(), 200);
  log('방 ' + sock.room + ' — P' + (id + 1) + ' 강제 퇴장');
}

function route(sock, to, enc, payload, isText){
  const r = rooms.get(sock.room);
  if (!r) return;
  const send = (target) => {
    if (!target) return;
    if (isText) target.sendText(JSON.stringify(payload));
    else target.sendBin(payload);
  };
  if (!sock.isHost){ send(r.host); return; }       // 참가자 → 방장에게만
  if (to === null || to === undefined || to === 255){
    r.clients.forEach(send);                       // 방장 → 전원
  } else send(r.clients.get(to));                  // 방장 → 한 명
}

function log(msg){
  const d = new Date();
  const t = String(d.getHours()).padStart(2,'0') + ':' +
            String(d.getMinutes()).padStart(2,'0') + ':' +
            String(d.getSeconds()).padStart(2,'0');
  console.log('[' + t + '] ' + msg);
}

server.listen(PORT, BIND, () => {
  console.log('');
  console.log('  NEOTONE 릴레이 서버가 떴습니다.');
  console.log('');
  if (BIND === '127.0.0.1' || BIND === 'localhost'){
    console.log('    ' + BIND + ':' + PORT + ' 에만 바인딩했습니다 (바깥에서 직접 접속 불가).');
    console.log('    nginx 같은 리버스 프록시를 앞에 두는 구성입니다.');
  } else {
    console.log('    이 PC에서       http://localhost:' + PORT + '/');
    console.log('    같은 와이파이   http://<이 PC의 IP>:' + PORT + '/');
  }
  console.log('');
  if (BIND !== '127.0.0.1' && BIND !== 'localhost'){
    console.log('  다른 네트워크에 있는 친구도 부르려면, 다른 터미널에서:');
    console.log('');
    console.log('    cloudflared tunnel --url http://localhost:' + PORT);
    console.log('');
    console.log('  → https://....trycloudflare.com 주소가 나옵니다. 그 주소를 공유하세요.');
    console.log('    (그 주소로 들어온 사람은 자동으로 이 서버를 통해 연결됩니다)');
    console.log('');
  }
  console.log('  동시 접속 한도 ' + MAX_SOCKETS + '명 · 동시 방 한도 ' + MAX_ROOMS + '개');
  console.log('  끄려면 Ctrl+C (서비스로 돌리는 경우는 systemctl stop neotone).');
  console.log('');
});
