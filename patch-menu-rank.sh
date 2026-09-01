#!/usr/bin/env bash
#
# 게임 선택 화면에 서버 공용 랭킹을 붙인다.
#
#   bash patch-menu-rank.sh                     # /var/www/games/index.html
#   bash patch-menu-rank.sh /경로/index.html
#
# 기존 마크업·스타일을 건드리지 않고 필요한 것만 끼워 넣는다.
# 이미 일부만 적용된 상태에서 다시 돌려도 빠진 카드만 채운다.
# 원본은 index.html.bak.<날짜시각> 으로 백업한다.
set -euo pipefail
F="${1:-/var/www/games/index.html}"
[ -f "$F" ] || { echo "파일을 찾을 수 없습니다: $F"; exit 1; }
BAK="$F.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$F" "$BAK"

python3 - "$F" <<'PYEOF'
import io, re, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()

# ── 1. 카드 찾기.
#     속성 순서를 가정하지 않는다. class="card" 인 <a> 를 전부 찾고 그 안에서 href 를 뽑는다.
#     (이전 버전은 href 가 class 보다 앞에 오는 형태만 찾아서, 그 형태인 카드 하나에만 들어갔다)
QQ = chr(34) + chr(39)                      # " 와 '
HREF = re.compile('href=[' + QQ + ']/([a-z]+)/[' + QQ + ']')
cards = []
for m in re.finditer(r'<a\b[^>]*>[\s\S]*?</a>', src):
    block = m.group(0)
    if 'class="card"' not in block and "class='card'" not in block:
        continue
    hm = HREF.search(block)
    if not hm:
        continue
    cards.append((m, hm.group(1)))

if not cards:
    print('  ✗ 카드(<a class="card" href="/게임/">)를 찾지 못했습니다.')
    sys.exit(2)

todo = [(m, k) for (m, k) in cards if 'data-g=' not in m.group(0)]

out, last, found = [], 0, []
for m, key in todo:
    block = m.group(0)
    ins = '<div class="rk" data-g="' + key + '"><div class="rkw">기록 불러오는 중…</div></div>'
    mp = list(re.finditer(r'</p>', block))
    if mp:
        at = mp[-1].end()
        nb = block[:at] + ins + block[at:]
    else:
        nb = block[:-4] + ins + '</a>'
    out.append(src[last:m.start()]); out.append(nb); last = m.end()
    found.append(key)
out.append(src[last:])
src = ''.join(out)

CSS = """
<style>
/* arcade-rank */
.rk{margin-top:10px;border-top:1px solid rgba(128,128,128,.22);padding-top:8px}
.rk .rkw{font-size:11px;opacity:.45}
.rk ol{list-style:none;margin:0;padding:0}
.rk li{display:flex;align-items:baseline;gap:6px;font-size:12px;line-height:1.75;opacity:.85}
.rk li .n{width:1.1em;text-align:right;opacity:.5;font-variant-numeric:tabular-nums}
.rk li.me{opacity:1;font-weight:700}
.rk li .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk li .sc{font-variant-numeric:tabular-nums;white-space:nowrap}
.rk li .sb{font-size:10px;opacity:.5;white-space:nowrap}
.rk li.gold .n{opacity:1;color:#e8b62c}
#namebar{display:flex;align-items:center;justify-content:center;gap:8px;
  margin:10px 0 4px;font-size:12px;opacity:.75;flex-wrap:wrap}
#namebar input{font:inherit;font-size:12px;width:8.5em;padding:4px 8px;border-radius:6px;
  border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.10);color:inherit;text-align:center}
#namebar button{font:inherit;font-size:12px;padding:4px 10px;border-radius:6px;cursor:pointer;
  border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.10);color:inherit}
#namebar .ok{color:#3aa76d}
</style>
"""

NAMEBAR = """
<div id="namebar">
  <span>랭킹에 쓸 이름</span>
  <input id="nmi" maxlength="8" placeholder="이름 (8자)" autocomplete="off" spellcheck="false">
  <button id="nmb" type="button">저장</button>
  <span id="nmok" class="ok"></span>
</div>
"""

JS = """
<script>
/* arcade-rank — 서버 공용 랭킹을 카드에 채운다.
   중요: 이름은 사람이 넣는 값이다. 절대 innerHTML 로 그리지 않는다.
   세 게임이 같은 출처라, 여기서 XSS 가 터지면 세 게임의 localStorage 가 전부 털린다. */
(function(){
  'use strict';
  var API = '/plane/api/rank';
  function ls(k, v){
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
    catch(e){ return null; }
  }

  // 이름 입력
  var nmi = document.getElementById('nmi');
  var nmb = document.getElementById('nmb');
  var nmok = document.getElementById('nmok');
  if (nmi){
    nmi.value = ls('arcade-name') || ls('overtake-name') || '';
    var save = function(){
      var v = (nmi.value || '').trim().slice(0, 8);
      ls('arcade-name', v);
      ls('overtake-name', v);            // 자동차 게임이 쓰던 키도 같이 맞춰 준다
      nmok.textContent = '저장됨';
      setTimeout(function(){ nmok.textContent = ''; }, 1500);
    };
    nmb.addEventListener('click', save);
    nmi.addEventListener('keydown', function(e){ if (e.key === 'Enter') save(); });
  }

  function row(e, mine){
    var li = document.createElement('li');
    if (e.r === 1) li.className = 'gold';
    if (mine) li.className += ' me';
    var n = document.createElement('span'); n.className = 'n'; n.textContent = e.r;
    var nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = e.name;   // textContent
    var sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = e.disp;
    li.appendChild(n); li.appendChild(nm);
    if (e.sub){ var sb = document.createElement('span'); sb.className = 'sb'; sb.textContent = e.sub; li.appendChild(sb); }
    li.appendChild(sc);
    return li;
  }
  function fill(box, g){
    box.textContent = '';
    if (!g || !g.top || !g.top.length){
      var d = document.createElement('div'); d.className = 'rkw';
      d.textContent = '아직 기록이 없습니다 — 1등 하세요';
      box.appendChild(d); return;
    }
    var ol = document.createElement('ol');
    // v2: uid 대신 지문으로 판단한다 (row.me === 그 게임의 meTag)
    for (var i = 0; i < g.top.length; i++)
      ol.appendChild(row(g.top[i], !!g.meTag && g.top[i].me === g.meTag));
    box.appendChild(ol);
    if (g.me && g.me.rank > g.top.length){
      var d2 = document.createElement('div'); d2.className = 'rkw';
      d2.textContent = '내 기록 ' + g.me.rank + '위 · ' + g.me.disp;
      box.appendChild(d2);
    }
  }
  function load(){
    var boxes = document.querySelectorAll('.rk');
    // uid 는 볼 때마다 새로 읽는다. v2 에서는 서버가 '판을 시작하는 순간' 에 발급하므로,
    // 페이지가 뜰 때 한 번만 읽어 두면 첫 판을 끝내고 열었을 때 내 기록을 못 찾는다.
    // (지어내면 안 된다 — 서명 없는 uid 는 서버가 그냥 버린다.)
    var uid = ls('arcade-uid') || '';
    // uid 가 없으면 파라미터째로 뺀다 — 서버는 서명된 uid 만 받고, 빈 값은 그냥 버려진다.
    fetch(API + '?n=3' + (uid ? '&uid=' + encodeURIComponent(uid) : ''), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.ok) throw new Error('bad');
        for (var i = 0; i < boxes.length; i++)
          fill(boxes[i], d.games[boxes[i].getAttribute('data-g')]);
      })
      .catch(function(){
        // 서버가 죽어도 메뉴는 떠야 한다. 카드 자체는 그대로 눌린다.
        for (var i = 0; i < boxes.length; i++){
          boxes[i].textContent = '';
          var d = document.createElement('div'); d.className = 'rkw';
          d.textContent = '랭킹 서버에 연결하지 못했습니다';
          boxes[i].appendChild(d);
        }
      });
  }
  load();
  // 게임을 하고 뒤로 돌아왔을 때 최신 기록이 보이게
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) load(); });
})();
</script>
"""

# 스타일/이름줄/스크립트는 이미 있으면 건너뛴다 (부분 적용 상태에서 다시 돌릴 수 있게)
if '/* arcade-rank */' not in src:
    src = src.replace('</head>', CSS + '</head>', 1) if '</head>' in src else CSS + src

if 'id="namebar"' not in src:
    first = None
    for m in re.finditer(r'<a\b[^>]*>', src):
        seg = src[m.start():m.start()+400]
        if 'class="card"' in seg or "class='card'" in seg:
            first = m; break
    if first: src = src[:first.start()] + NAMEBAR + src[first.start():]

# 예전에 넣은 블록은 걷어내고 항상 최신판을 다시 넣는다.
# '이미 있으니 넘어감' 으로 두면 이 스크립트를 새로 받아도 옛날 코드가 그대로 남는다.
n_up = 0
def strip_block(text, tag):
    # 블록은 <style>…</style><div>…</div><script>…</script> 통짜이거나 <script> 하나뿐이다.
    # <style> 형태를 먼저 시도해야 한다 — <script> 부터 지우면 앞의 스타일/마크업이 남는다.
    global n_up
    hit = False
    for pre in ('<style>', '<script>'):
        while tag in text:
            t2 = re.sub(r'\n?' + pre + r'\s*/\* ' + tag + r'[\s\S]*?</script>\s*', '\n', text, count=1)
            if t2 == text: break
            text = t2; hit = True
    if hit: n_up += 1
    return text

src = strip_block(src, 'arcade-rank —')
src = src.replace('</body>', JS + '</body>', 1) if '</body>' in src else src + JS

OVERLAY = """<style>
/* arcade-rankui — 세 게임 + 메인이 공유하는 랭킹 화면 */
#arkWrap{position:fixed;inset:0;z-index:99999;display:none;
  background:rgba(6,9,14,.90);backdrop-filter:blur(6px);
  font:400 14px/1.5 'Menlo','Consolas',ui-monospace,monospace;color:#e6ebf2;
  -webkit-tap-highlight-color:transparent}
#arkWrap.on{display:flex;align-items:flex-start;justify-content:center}
#arkBox{width:100%;max-width:460px;max-height:100%;overflow-y:auto;
  padding:18px 16px calc(24px + env(safe-area-inset-bottom,0px));
  -webkit-overflow-scrolling:touch}
#arkTop{display:flex;align-items:center;gap:10px;margin-bottom:14px}
#arkTop h2{margin:0;font-size:19px;font-weight:700;letter-spacing:1px;flex:1}
#arkX{border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.06);
  color:inherit;font:inherit;font-size:13px;border-radius:8px;padding:6px 12px;cursor:pointer}
#arkX:active{background:rgba(255,255,255,.16)}
#arkTabs{display:flex;gap:6px;margin-bottom:12px}
#arkTabs button{flex:1;min-width:0;border:1px solid rgba(255,255,255,.16);
  background:rgba(255,255,255,.04);color:rgba(255,255,255,.62);
  font:inherit;font-size:12px;border-radius:9px;padding:9px 4px;cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#arkTabs button.sel{background:rgba(255,210,87,.14);border-color:#ffd257;color:#ffd257;font-weight:700}
#arkList{list-style:none;margin:0 0 14px;padding:0;min-height:120px}
#arkList li{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:9px}
#arkList li:nth-child(odd){background:rgba(255,255,255,.035)}
#arkList li.me{background:rgba(92,255,158,.13);box-shadow:inset 0 0 0 1px rgba(92,255,158,.42)}
#arkList .rk{width:1.6em;text-align:right;font-weight:700;color:rgba(255,255,255,.38);
  font-variant-numeric:tabular-nums}
#arkList li:nth-child(1) .rk{color:#ffd257}
#arkList li:nth-child(2) .rk{color:#d8dde5}
#arkList li:nth-child(3) .rk{color:#d99a5c}
#arkList .who{flex:1;min-width:0}
#arkList .nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
#arkList li.me .nm{color:#5cff9e;font-weight:700}
#arkList .sb{display:block;font-size:10px;color:rgba(255,255,255,.36);margin-top:1px}
#arkList .sc{font-size:15px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
#arkList li.me .sc{color:#5cff9e}
#arkList li.empty{color:rgba(255,255,255,.24);justify-content:center;font-size:12px;padding:14px}
#arkMine{font-size:12px;color:rgba(255,255,255,.55);margin:-6px 0 14px;text-align:center}
#arkName{display:flex;align-items:center;gap:8px;font-size:12px;
  color:rgba(255,255,255,.55);border-top:1px solid rgba(255,255,255,.12);padding-top:13px}
/* 16px 미만이면 iOS 사파리가 포커스 시 페이지를 확대한다.
   캔버스 게임에서는 화면이 밀려 탭 좌표가 통째로 어긋나므로 반드시 16px 이상. */
#arkName input{flex:1;min-width:0;font:inherit;font-size:16px;text-align:center;
  padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.22);
  background:rgba(255,255,255,.06);color:#fff}
#arkName button{font:inherit;font-size:12px;padding:8px 13px;border-radius:8px;cursor:pointer;
  border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.06);color:inherit}
#arkOk{color:#5cff9e;min-width:3.4em}
#arkNote{font-size:11px;color:rgba(255,255,255,.3);text-align:center;margin-top:12px}
</style>
<div id="arkWrap"><div id="arkBox">
  <div id="arkTop"><h2>랭킹</h2><button id="arkX" type="button">닫기</button></div>
  <div id="arkTabs"></div>
  <ul id="arkList"></ul>
  <div id="arkMine"></div>
  <div id="arkName">
    <span>이름</span>
    <input id="arkNm" maxlength="8" placeholder="이름 (8자)" autocomplete="off" spellcheck="false">
    <button id="arkNb" type="button">저장</button><span id="arkOk"></span>
  </div>
  <div id="arkNote">기록은 게임이 끝날 때 자동으로 올라갑니다</div>
</div></div>
<script>
/* arcade-rankui — 세 게임과 메인이 함께 쓰는 랭킹 화면.
   서버가 3게임을 한 번에 주므로(/plane/api/rank) 요청 1회로 전부 채운다.
   이름은 사람이 넣는 값이다 — 절대 innerHTML 로 그리지 않는다(textContent 만).
   세 게임이 같은 출처라 여기서 XSS 가 터지면 전부 털린다. */
(function(){
  'use strict';
  if (window.ArcadeRankUI) return;
  var API = '/plane/api/rank';
  var wrap = document.getElementById('arkWrap');
  if (!wrap) return;
  var tabs = document.getElementById('arkTabs'), list = document.getElementById('arkList');
  var mine = document.getElementById('arkMine'), nm = document.getElementById('arkNm');
  var ok = document.getElementById('arkOk'), open = false, data = null, cur = null;

  function ls(k, v){
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
    catch(e){ return null; }
  }
  // 이 게임이 뭔지 경로로 짐작해서 그 탭을 먼저 연다
  var SELF = (function(){
    try {
      var p = location.pathname;
      if (p.indexOf('/race') === 0) return 'race';
      if (p.indexOf('/plane') === 0) return 'plane';
      if (p.indexOf('/jumprope') === 0) return 'jumprope';
    } catch(e){}
    return null;
  })();

  function row(e, isMe){
    var li = document.createElement('li');
    if (isMe) li.className = 'me';
    var a = document.createElement('span'); a.className = 'rk'; a.textContent = e.r;
    var w = document.createElement('span'); w.className = 'who';
    var n = document.createElement('span'); n.className = 'nm'; n.textContent = e.name;
    w.appendChild(n);
    if (e.sub){ var s = document.createElement('span'); s.className = 'sb'; s.textContent = e.sub; w.appendChild(s); }
    var c = document.createElement('span'); c.className = 'sc'; c.textContent = e.disp;
    li.appendChild(a); li.appendChild(w); li.appendChild(c);
    return li;
  }
  function draw(){
    tabs.textContent = ''; list.textContent = ''; mine.textContent = '';
    if (!data){
      var li0 = document.createElement('li'); li0.className = 'empty';
      li0.textContent = '불러오는 중…'; list.appendChild(li0); return;
    }
    if (data.err){
      var li1 = document.createElement('li'); li1.className = 'empty';
      li1.textContent = '랭킹 서버에 연결하지 못했습니다'; list.appendChild(li1); return;
    }
    var keys = Object.keys(data.games);
    keys.forEach(function(k){
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = data.games[k].label || k;
      if (k === cur) b.className = 'sel';
      b.addEventListener('click', function(){ cur = k; draw(); });
      tabs.appendChild(b);
    });
    var g = data.games[cur];
    if (!g || !g.top || !g.top.length){
      var li2 = document.createElement('li'); li2.className = 'empty';
      li2.textContent = '아직 기록이 없습니다 — 1등 하세요';
      list.appendChild(li2); return;
    }
    // v2: 응답 항목에 uid 가 없다. 게임 구간마다 오는 meTag(내 지문)와 각 행의 me 를 비교한다.
    // meTag 는 내 기록이 그 게임 목록에 있을 때만 온다 — 없으면 강조할 행도 없다.
    for (var i = 0; i < g.top.length; i++)
      list.appendChild(row(g.top[i], !!g.meTag && g.top[i].me === g.meTag));
    if (g.me && g.me.rank > g.top.length) mine.textContent = '내 기록 ' + g.me.rank + '위 · ' + g.me.disp;
  }
  function load(){
    data = null; draw();
    // file:// 로 직접 열었으면 부를 서버가 없다 (README 가 안내하는 오프라인 플레이)
    try { if (location.protocol === 'file:'){ data = { err: 1 }; draw(); return; } } catch(e){}
    // uid 는 볼 때마다 새로 읽는다. v2 에서는 서버가 '판을 시작하는 순간' 에 발급하므로,
    // 페이지가 뜰 때 한 번만 읽어 두면 첫 판을 끝내고 열었을 때 내 기록을 못 찾는다.
    // (지어내면 안 된다 — 서명 없는 uid 는 서버가 그냥 버린다.)
    var uid = ls('arcade-uid') || '';
    // uid 가 없으면 파라미터째로 뺀다 — 서버는 서명된 uid 만 받고, 빈 값은 그냥 버려진다.
    fetch(API + '?n=10' + (uid ? '&uid=' + encodeURIComponent(uid) : ''), { cache: 'no-store' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (!d || !d.ok) throw new Error('bad');
        data = d;
        if (!cur || !data.games[cur]) cur = (SELF && data.games[SELF]) ? SELF : Object.keys(data.games)[0];
        draw();
      })
      .catch(function(){ data = { err: 1 }; draw(); });
  }
  function show(){
    if (open) return;
    open = true;
    nm.value = ls('arcade-name') || ls('overtake-name') || '';
    wrap.classList.add('on');
    load();
  }
  function hide(){
    if (!open) return;
    open = false;
    wrap.classList.remove('on');
    try { nm.blur(); } catch(e){}
  }
  function save(){
    var v = (nm.value || '').trim().slice(0, 8);
    ls('arcade-name', v); ls('overtake-name', v);
    ok.textContent = '저장됨';
    setTimeout(function(){ ok.textContent = ''; }, 1400);
  }
  document.getElementById('arkX').addEventListener('click', hide);
  document.getElementById('arkNb').addEventListener('click', save);
  nm.addEventListener('keydown', function(e){
    e.stopPropagation();                       // 게임 전역 키 핸들러로 새지 않게
    if (e.key === 'Enter'){ e.preventDefault(); save(); nm.blur(); }
  });
  nm.addEventListener('keyup', function(e){ e.stopPropagation(); });
  wrap.addEventListener('click', function(e){ if (e.target === wrap) hide(); });
  // 열려 있는 동안 키가 게임으로 새지 않게 (캡처 단계에서 먼저 잡는다)
  ['keydown','keyup','keypress'].forEach(function(t){
    window.addEventListener(t, function(e){
      if (!open) return;
      if (e.key === 'Escape'){ hide(); e.preventDefault(); }
      e.stopPropagation();
    }, true);
  });
  // 캔버스 게임이 window 에 걸어 둔 핸들러로 이벤트가 새지 않게 막는다.
  // 반드시 "버블 단계" 여야 한다 — 캡처로 걸면 오버레이 안의 버튼(탭·닫기·저장)에
  // 이벤트가 닿기도 전에 삼켜서 아무것도 안 눌린다. (실제로 그렇게 만들었다가 잡았다)
  ['touchstart','touchmove','touchend','mousedown','mouseup','click','pointerdown'].forEach(function(t){
    wrap.addEventListener(t, function(e){ e.stopPropagation(); }, false);
  });

  window.ArcadeRankUI = { open: show, close: hide, isOpen: function(){ return open; }, reload: load };
})();
</script>
"""

MOREBTN = """
<div style="text-align:center;margin:14px 0 2px">
  <button id="arkMore" type="button" style="font:600 12px/1 system-ui,-apple-system,sans-serif;
    color:inherit;background:rgba(128,128,128,.12);border:1px solid rgba(128,128,128,.38);
    border-radius:20px;padding:9px 16px;cursor:pointer">전체 랭킹 보기 (TOP 10)</button>
</div>
<script>
(function(){
  var b = document.getElementById('arkMore');
  if (b) b.addEventListener('click', function(){ if (window.ArcadeRankUI) window.ArcadeRankUI.open(); });
})();
</script>
"""

src = strip_block(src, 'arcade-rankui')
if 'arcade-rankui' in src:
    print('  ✗ 예전 랭킹 화면 블록을 걷어내지 못했습니다. 백업본으로 되돌린 뒤 알려 주세요.')
    sys.exit(3)
src = src.replace('</body>', OVERLAY + '</body>', 1) if '</body>' in src else src + OVERLAY
if 'arkMore' not in src:
    # 마지막 카드 뒤에 넣는다
    last = None
    for m in re.finditer(r'</a>', src): last = m
    if last: src = src[:last.end()] + MOREBTN + src[last.end():]

io.open(path, 'w', encoding='utf-8').write(src)
print('  ✓ {0} — 이번에 붙인 카드: {1} / 전체 카드 {2}개'.format(
      '최신판으로 교체했습니다' if n_up else '적용 완료',
      ', '.join(found) if found else '(이미 붙어 있음)', len(cards)))
PYEOF

RC=$?
if [ "$RC" -eq 0 ]; then
  echo; echo "백업: $BAK"; echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  rm -f "$BAK"; exit "$RC"
fi
