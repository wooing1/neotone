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
//   ④ 물리적 한계 — 게임 코드에서 계산한 "1초에 최대 몇 점까지 가능한가".
//      서버가 재는 실제 경과 시간과 곱해서, 그보다 큰 점수는 거절한다.
//
// perSec 은 게임 코드에서 유도한 이론상 최대치에 30% 여유를 더한 값이다.
// 정직한 플레이어를 절대 튕기지 않는 게 우선이라 실측보다 3~4배 헐겁게 잡았다.
//   race  : 주행 100.0 m/s (SPD_MAX 22.5 × 60 × M_PER_UNIT) + 아슬아슬 384.5 m/s
//           (초당 최대 7.37대 스폰 × 1회 52.15m) = 484.5 → 630
//   plane : 보스 피해 13,600/s + 그레이즈 11,500/s (탄 생성률 46발/초 × 250점)
//           = 25,100 → 33,000
//   jumprope: 실물 소스를 아직 못 봐서 잠정치다. 넉넉하게 두었다.
const GAMES = {
  jumprope: { label: '탭탭 줄넘기', unit: '점', max: 200000,    perSec: 400,   minRun: 2.0, sub: [['combo','콤보']] },
  plane:    { label: 'NEOTONE',    unit: '점', max: 10000000,  perSec: 33000, minRun: 1.5, sub: [['stage','ST']] },
  race:     { label: '쌩쌩 추월',  unit: 'm',  max: 200000,    perSec: 630,   minRun: 1.0, sub: [['overtakes','추월']] },
};
// meta 는 아래 표에 있는 키만, 숫자로만 받는다. 서버가 문자열을 저장하면
// 조회하는 모든 사람에게 그대로 퍼진다 (레드팀이 <img onerror> 를 통과시켰다).
const META_KEYS = { combo: 1e7, stage: 99, overtakes: 1e5, nearMiss: 1e5, sec: 86400 };
const KEEP = 20;                       // 게임당 보관 건수
const PER_IP_SLOTS = 3;                // 한 IP 가 한 게임 순위표에서 차지할 수 있는 최대 칸

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
// 랭킹 쪽 어떤 예외도 4인 릴레이를 끊으면 안 된다. 게임이 도는 게 우선이다.
process.on('uncaughtException', e => {
  console.log('  ! 처리되지 않은 예외 (계속 실행합니다): ' + (e && e.stack || e));
});
function flushAll(){
  if (saveTimer){ clearTimeout(saveTimer); saveRanksNow(); }
  if (usedTimer || usedDirty){ if (usedTimer) clearTimeout(usedTimer); saveUsedNow(); }
}
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
process.on('SIGINT',  () => { flushAll(); process.exit(0); });

/* ══════════════════════════════════════════════════════════
   위조 방지 — 신원과 "플레이했다는 증거"를 서버가 쥔다
   ══════════════════════════════════════════════════════════
   먼저 솔직하게: 브라우저에서 도는 게임의 점수를 서버가 "진짜"라고 증명할 방법은
   없다. 게임 로직 전체를 서버에서 다시 돌리지 않는 한, 클라이언트가 보내는 숫자는
   전부 자기 신고다. 그래서 목표를 "불가능하게" 가 아니라
   "개발자도구 한 줄로는 안 되고, 진짜로 플레이하는 것만큼 시간이 들게" 로 잡는다.

   장치 세 가지.
     ① 신원을 서버가 발급한다 — uid 를 클라이언트가 고르면 남의 기록을 덮어쓰거나
        무한히 만들어 순위표 20칸을 전부 채울 수 있다 (레드팀이 둘 다 성공했다).
     ② 런 토큰 — 판을 시작할 때 서버가 서명한 1회용 표를 받아 가고, 제출할 때 낸다.
        경과 시간은 그 표의 발급 시각으로 서버가 직접 잰다. 클라이언트가 보낸
        meta.sec 은 절대 쓰지 않는다 — 그걸 믿으면 이 규칙 전체가 무의미해진다.
     ③ 물리적 한계 — 점수가 (경과 시간 × 게임별 최대 초당 점수) 를 넘으면 거절한다.
        20,000m 를 받으려면 실제로 32초를 기다려야 한다.

   남는 구멍도 적어 둔다: 시간을 들여 스크립트를 짜는 사람은 토큰을 받고 기다렸다가
   그럴듯한 점수를 낼 수 있다. 그걸 막으려면 서버가 게임을 다시 돌려야 하고,
   그건 이 프로젝트의 범위를 넘는다. */

// 서버 비밀키. 재시작해도 유지돼야 발급한 uid/토큰이 안 죽는다.
const SECRET = (function(){
  const f = path.join(DATA_DIR, 'secret');
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (v.length >= 32) return v; } catch(e){}
  const v = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, v, { mode: 0o600 }); }
  catch(e){ console.log('  ! 비밀키를 저장하지 못했습니다 — 재시작하면 발급된 신원이 초기화됩니다: ' + e.message); }
  return v;
})();
const mac = (s, n) => crypto.createHmac('sha256', SECRET).update(String(s)).digest('base64url').slice(0, n);

/* ── 신원 ── uid 는 서버만 만들 수 있다. 형식: u<12hex>.<10자 서명> */
function makeUid(){
  const core = 'u' + crypto.randomBytes(6).toString('hex');
  return core + '.' + mac('uid|' + core, 10);
}
function validUid(v){
  const u = String(v == null ? '' : v);
  const i = u.indexOf('.');
  if (i < 1 || u.length > 32) return null;
  const core = u.slice(0, i), sig = u.slice(i + 1);
  if (!/^u[0-9a-f]{12}$/.test(core)) return null;
  // 타이밍 공격은 여기선 의미가 없지만(오프라인 위조가 더 쉬움) 습관을 지킨다
  const want = mac('uid|' + core, 10);
  if (sig.length !== want.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) ? u : null;
}

/* ── 런 토큰 ── 판을 시작할 때 발급, 제출할 때 1회만 사용 */
const TOKEN_TTL = 3 * 3600 * 1000;     // 3시간. 그 안에 제출하지 않으면 무효
const USED_FILE = path.join(DATA_DIR, 'used.json');
// 쓴 토큰은 디스크에도 남긴다. 메모리에만 두면 서버를 재시작하는 순간
// 3시간 안에 쓴 토큰이 전부 다시 유효해진다 (배포할 때마다 창이 열린다).
const usedTok = new Map();             // nonce → 만료 시각
(function loadUsed(){
  try {
    const o = JSON.parse(fs.readFileSync(USED_FILE, 'utf8'));
    const now = Date.now();
    if (o && typeof o === 'object')
      for (const k of Object.keys(o)){ const e = Number(o[k]); if (e > now) usedTok.set(k, e); }
  } catch(e){}
})();
let usedTimer = null, usedDirty = false;
function saveUsedNow(){
  usedTimer = null; usedDirty = false;
  const o = {}; for (const [k, e] of usedTok) o[k] = e;
  const tmp = USED_FILE + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(o), 'utf8'); fs.renameSync(tmp, USED_FILE); }
  catch(e){ try { fs.unlinkSync(tmp); } catch(e2){} }
}
// 랭킹과 같은 이유로 5초로 묶는다 — 제출마다 디스크를 때리면 릴레이가 끊긴다
function saveUsed(){ usedDirty = true; if (!usedTimer) usedTimer = setTimeout(saveUsedNow, 5000); }
function sweepUsed(now){
  if (usedTok.size < 4000) return;
  for (const [k, exp] of usedTok) if (exp < now) usedTok.delete(k);
  // 만료된 걸 다 지워도 여전히 많으면, 지우는 대신 가장 오래된 것부터 버린다.
  // 통째로 clear() 하면 아직 안 만료된 토큰이 전부 재사용 가능해진다.
  if (usedTok.size > 20000){
    const keys = [...usedTok.keys()].slice(0, usedTok.size - 20000);
    for (const k of keys) usedTok.delete(k);
  }
  saveUsed();
}
function makeToken(game, uid){
  const nonce = crypto.randomBytes(9).toString('base64url');
  const body = game + '|' + uid + '|' + Date.now() + '|' + nonce;
  return Buffer.from(body, 'utf8').toString('base64url') + '.' + mac('tok|' + body, 12);
}
function readToken(v){
  const t = String(v == null ? '' : v);
  if (t.length > 300) return null;
  const i = t.lastIndexOf('.');
  if (i < 1) return null;
  let body;
  try { body = Buffer.from(t.slice(0, i), 'base64url').toString('utf8'); } catch(e){ return null; }
  const sig = t.slice(i + 1), want = mac('tok|' + body, 12);
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  const p = body.split('|');
  if (p.length !== 4) return null;
  const at = Number(p[2]);
  if (!isFinite(at)) return null;
  return { game: p[0], uid: p[1], at, nonce: p[3] };
}

/* ── IP 단위 한도 ── uid 를 회전시키는 도배를 막는 진짜 방어선.
   레드팀이 단일 클라이언트로 초당 5,900건을 통과시켰다. */
const ipHits = new Map();              // ip → { tok:[], sub:[] } 각각 타임스탬프 배열
const IP_LIMIT = { tok: 40, sub: 25, win: 60000 };   // 1분 창
function ipAllow(ip, kind){
  const now = Date.now();
  if (ipHits.size > 5000) ipHits.clear();
  let e = ipHits.get(ip);
  if (!e){ e = { tok: [], sub: [] }; ipHits.set(ip, e); }
  const arr = e[kind];
  while (arr.length && now - arr[0] > IP_LIMIT.win) arr.shift();
  if (arr.length >= IP_LIMIT[kind]) return false;
  arr.push(now);
  return true;
}
/* X-Forwarded-For 는 "첫 값이 진짜 클라이언트" 가 아니다.
   nginx 의 proxy_add_x_forwarded_for 는 기존 헤더 뒤에 실제 접속 IP 를 *덧붙인다*.
   그래서 공격자가 헤더를 달고 오면 그 값이 맨 앞에 오고, 첫 값을 믿으면
   헤더 한 줄로 IP 를 무한히 바꿔 레이트리밋과 슬롯 제한을 통째로 우회한다
   (레드팀이 이 방법으로 순위표 20칸을 전부 점거하고 초당 2,600건을 통과시켰다).

   신뢰할 수 있는 건 "내 앞의 프록시가 직접 본 주소" 뿐이고, 그건 목록의 *뒤에서*
   TRUST_HOPS 번째다. 프록시가 하나(nginx)면 마지막 값이다.
   프록시를 거치지 않고 직접 노출된 경우엔 헤더를 아예 믿지 않는다. */
const TRUST_HOPS = Math.max(0, parseInt(process.env.NEOTONE_TRUST_HOPS || '1', 10));
// 헤더를 믿을지 여부를 설정에 맡기면 안 된다. 프록시 없이 직접 노출된 서버가
// 기본값 1 을 그대로 쓰면 다시 통째로 뚫린다 (레드팀이 이 오배포를 재현했다).
// 그래서 "바로 앞에 있는 상대가 로컬 프록시일 때만" 헤더를 본다. 인터넷에서
// 직접 들어온 연결의 X-Forwarded-For 는 그냥 사용자가 적어 넣은 낙서다.
function isLocalPeer(a){
  const v = String(a || '').replace(/^::ffff:/, '');
  return v === '127.0.0.1' || v === '::1' || v === '' ||
         /^10\./.test(v) || /^192\.168\./.test(v) || /^169\.254\./.test(v) ||
         /^172\.(1[6-9]|2\d|3[01])\./.test(v) || /^f[cd]/i.test(v);
}
function clientIp(req){
  const peer = String(req.socket.remoteAddress || '').slice(0, 64);
  if (TRUST_HOPS > 0 && isLocalPeer(peer)){
    const xf = req.headers['x-forwarded-for'];
    if (xf){
      const hops = String(xf).split(',').map(v => v.trim()).filter(Boolean);
      const v = hops[hops.length - TRUST_HOPS];
      if (v) return v.slice(0, 64);
    }
  }
  return peer || '?';
}
const ipTag = ip => mac('ip|' + ip, 8);    // 순위표에 원문 IP 를 저장하지 않는다

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
  // uid 를 응답에 실으면 안 된다 — 그걸로 남의 기록에 덮어쓸 수 있다.
  // '이게 나인가' 를 판단할 짧은 지문만 내보낸다. ipT 도 절대 나가면 안 된다.
  return { r: i + 1, me: mac('me|' + e.uid, 8), name: e.name, score: e.score,
           disp: fmtScore(g, e.score), sub: sub.join(' · '), ts: e.ts };
}
function topOf(g, n, uid){
  const list = ranks.games[g] || [];
  const out = { label: GAMES[g].label, unit: GAMES[g].unit, total: list.length,
                top: list.slice(0, n).map((e, i) => viewEntry(g, e, i)), me: null };
  if (uid){
    const i = list.findIndex(e => e.uid === uid);
    if (i >= 0) out.meTag = mac('me|' + uid, 8);
    if (i >= 0) out.me = { rank: i + 1, score: list[i].score, disp: fmtScore(g, list[i].score) };
  }
  return out;
}

function submitRank(d, ip){
  const now = Date.now();
  const g = String(d.game || '');
  if (!GAMES[g]) return { ok: false, err: 'unknown game' };
  if (!ipAllow(ip, 'sub')) return { ok: false, err: 'too many' };

  // ── ① 런 토큰. 이게 없으면 "플레이했다"는 근거가 하나도 없다.
  const tk = readToken(d.tok);
  if (!tk) return { ok: false, err: 'no token' };
  if (tk.game !== g) return { ok: false, err: 'token mismatch' };
  if (now - tk.at > TOKEN_TTL || now - tk.at < 0) return { ok: false, err: 'token expired' };
  sweepUsed(now);
  if (usedTok.has(tk.nonce)) return { ok: false, err: 'token used' };
  const uid = validUid(tk.uid);
  if (!uid) return { ok: false, err: 'bad uid' };

  // ── ② 경과 시간은 서버가 잰다. 클라이언트의 meta.sec 은 표시용일 뿐 믿지 않는다.
  const elapsed = (now - tk.at) / 1000;
  if (elapsed < GAMES[g].minRun) return { ok: false, err: 'too fast' };

  // ── ③ 점수가 물리적으로 가능한 범위인가
  const score = Math.round(Number(d.score));
  if (!isFinite(score) || score < 0 || score > GAMES[g].max) return { ok: false, err: 'bad score' };
  const ceil = Math.ceil(GAMES[g].perSec * elapsed);
  if (score > ceil){
    console.log('[의심] ' + g + ' — ' + score + GAMES[g].unit + ' / ' + elapsed.toFixed(1) +
                '초 (한계 ' + ceil + ') ip=' + ipTag(ip));
    return { ok: false, err: 'impossible', max: ceil, sec: +elapsed.toFixed(1) };
  }

  // 여기까지 왔으면 토큰을 소모한다 (실패한 시도로는 토큰을 태우지 않는다 —
  // 정직한 사람이 네트워크 오류로 한 번 실패했을 때 판을 통째로 잃지 않게)
  usedTok.set(tk.nonce, now + TOKEN_TTL); saveUsed();

  // ── ④ meta 는 화이트리스트 숫자만. 문자열을 저장하면 조회하는 모두에게 퍼진다.
  const meta = {};
  const src = (d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta)) ? d.meta : {};
  for (const k of Object.keys(META_KEYS)){
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const n = Number(src[k]);
    if (!isFinite(n)) continue;
    meta[k] = Math.max(0, Math.min(META_KEYS[k], Math.round(n)));
  }

  const list = ranks.games[g];
  const name = cleanName(d.name);
  const tag = ipTag(ip);

  // ── ⑤ 한 IP 가 순위표를 통째로 먹지 못하게. uid 를 아무리 새로 받아도
  //     한 게임당 PER_IP_SLOTS 칸을 넘지 못한다.
  const prev = list.findIndex(e => e.uid === uid);
  if (prev < 0){
    const mine = [];
    for (let i = 0; i < list.length; i++) if (list[i].ipT === tag) mine.push(i);
    if (mine.length >= PER_IP_SLOTS){
      // 내 것 중 가장 낮은 기록을 찾아, 그보다 높을 때만 그 자리를 대체한다
      let worst = mine[0];
      for (const i of mine) if (list[i].score < list[worst].score) worst = i;
      if (list[worst].score >= score)
        return { ok: true, rank: null, best: false, n: list.length, unit: GAMES[g].unit,
                 note: 'ip slots', top: list.slice(0, 10).map((e, i) => viewEntry(g, e, i)) };
      list.splice(worst, 1);
    }
  }

  let best = true;
  const at = list.findIndex(e => e.uid === uid);
  if (at >= 0){
    // uid 당 1건만 둔다 — 한 명이 열 칸을 다 먹는 것도, 도배로 파일이 커지는 것도 막는다
    // 점수가 안 늘었으면 이름도 바꾸지 않는다.
    // 예전에는 여기서 이름을 갱신해 줘서, uid 만 알면 낮은 점수로 남의 행을
    // 원하는 문구로 도배할 수 있었다 (레드팀이 'HACKED' 로 바꾸는 데 성공했다).
    if (list[at].score >= score){ best = false; }
    else list[at] = { uid, name, score, ts: now, meta, ipT: tag };
  } else {
    list.push({ uid, name, score, ts: now, meta, ipT: tag });
  }
  list.sort((a, b) => (b.score - a.score) || (a.ts - b.ts));
  if (list.length > KEEP) list.length = KEEP;
  saveRanks();

  const rank = list.findIndex(e => e.uid === uid);
  console.log('[' + new Date().toTimeString().slice(0,8) + '] ' + g + ' — ' +
              name + ' ' + fmtScore(g, score) + '  ' + elapsed.toFixed(1) + '초' +
              (rank >= 0 ? ' (' + (rank+1) + '위)' : ''));
  return { ok: true, rank: rank >= 0 ? rank + 1 : null, best, n: list.length,
           unit: GAMES[g].unit, top: list.slice(0, 10).map((e, i) => viewEntry(g, e, i)) };
}

// 판 시작 — 신원과 1회용 표를 준다
function startRun(d, ip){
  const g = String(d.game || '');
  if (!GAMES[g]) return { ok: false, err: 'unknown game' };
  if (!ipAllow(ip, 'tok')) return { ok: false, err: 'too many' };
  const uid = validUid(d.uid) || makeUid();
  return { ok: true, uid, tok: makeToken(g, uid) };
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
  if (/^\/(?:plane\/)?api\/rank(\/start)?(\?|$)/.test(req.url || '')){
    const json = (code, o) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8',
                            'Cache-Control': 'no-store' });
      res.end(JSON.stringify(o));
    };
    const start = /^\/(?:plane\/)?api\/rank\/start(\?|$)/.test(req.url || '');
    if (req.method === 'POST'){
      readBody(req, (err, body) => {
        if (err) return json(413, { ok: false, err: 'too large' });
        let d; try { d = JSON.parse(body || '{}'); } catch(e){ return json(400, { ok:false, err:'bad json' }); }
        const ip = clientIp(req);
        const r = start ? startRun(d, ip) : submitRank(d, ip);
        json(r.ok ? 200 : (r.err === 'too many' ? 429 : 400), r);
      });
      return;
    }
    if (start) return json(405, { ok: false, err: 'method' });
    if (req.method !== 'GET') return json(405, { ok: false, err: 'method' });
    const q = {};
    const qs = (req.url.split('?')[1] || '');
    // decodeURIComponent 는 '%ZZ' 같은 값에 URIError 를 던진다.
    // 여기서 안 잡으면 요청 하나로 프로세스가 죽고 랭킹뿐 아니라 4인 릴레이까지 끊긴다.
    // (레드팀이 `/api/rank?uid=%ZZ` 한 번으로 서버를 100% 재현율로 죽였다)
    const dec = v => { try { return decodeURIComponent(v); } catch(e){ return v; } };
    for (const kv of qs.split('&')){
      if (!kv) continue;
      const i = kv.indexOf('=');
      q[dec(i < 0 ? kv : kv.slice(0, i))] = i < 0 ? '' : dec(kv.slice(i + 1));
    }
    const n = Math.max(1, Math.min(20, parseInt(q.n, 10) || 3));
    const uid = validUid(q.uid) || '';
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
