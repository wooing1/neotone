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

/* ── index.html 서빙 (릴레이 사용 표시를 끼워 넣는다) ── */
const HTML_PATH = path.join(__dirname, 'index.html');
function pageHtml(){
  let html = fs.readFileSync(HTML_PATH, 'utf8');
  // 주의: 게임 코드 안에도 __NEOTONE_WS 라는 이름이 나온다.
  // 그래서 "이미 끼워 넣었는지"는 주입 표시 전체로 판별해야 한다.
  const flag = '<script>window.__NEOTONE_WS=1;/*neotone-relay*/</script>';
  if (html.includes('/*neotone-relay*/')) return html;
  return html.replace(/<head[^>]*>/i, m => m + flag);
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
  if (/\/health(\?|$)/.test(req.url || '')){
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, sockets: sockCount,
                             maxSockets: MAX_SOCKETS, maxRooms: MAX_ROOMS }));
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
