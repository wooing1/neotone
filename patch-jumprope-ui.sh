#!/usr/bin/env bash
#
# 탭탭 줄넘기에 "게임 목록 / 랭킹" 바와 공용 랭킹 화면을 붙인다.
#   (예전 patch-jumprope-home.sh 를 대체합니다 — 그걸 이미 돌렸어도 안전합니다)
#
#   bash patch-jumprope-ui.sh                      # /var/www/games/jumprope/index.html
#   bash patch-jumprope-ui.sh /경로/index.html
#
# 게임 마크업은 건드리지 않는다. 화면 위에 올리는 것만 추가한다.
set -euo pipefail
F="${1:-/var/www/games/jumprope/index.html}"
[ -f "$F" ] || { echo "파일을 찾을 수 없습니다: $F"; exit 1; }
BAK="$F.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$F" "$BAK"

python3 - "$F" <<'PYEOF'
import io, re, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()
if '</body>' not in src:
    print('  ✗ </body> 를 찾지 못했습니다.'); sys.exit(2)

OV  = """<style>
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
  var uid = ls('arcade-uid');
  if (!uid){
    uid = Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
    ls('arcade-uid', uid);
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
    for (var i = 0; i < g.top.length; i++) list.appendChild(row(g.top[i], g.top[i].uid === uid));
    if (g.me && g.me.rank > g.top.length) mine.textContent = '내 기록 ' + g.me.rank + '위 · ' + g.me.disp;
  }
  function load(){
    data = null; draw();
    // file:// 로 직접 열었으면 부를 서버가 없다 (README 가 안내하는 오프라인 플레이)
    try { if (location.protocol === 'file:'){ data = { err: 1 }; draw(); return; } } catch(e){}
    fetch(API + '?n=10&uid=' + encodeURIComponent(uid), { cache: 'no-store' })
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
  // 캔버스 게임이 window 에 걸어 둔 핸들러로 이벤트가 새지 않게 (반드시 버블 단계)
  ['touchstart','touchmove','touchend','mousedown','mouseup','click','pointerdown'].forEach(function(t){
    wrap.addEventListener(t, function(e){ e.stopPropagation(); }, false);
  });

  window.ArcadeRankUI = { open: show, close: hide, isOpen: function(){ return open; }, reload: load };
})();
</script>
"""

BAR = """<style>
/* arcade-bar — 세 게임 공통 상단 바 (목록 / 랭킹). 플레이 중에는 숨는다. */
#arkBar{position:fixed;left:0;top:0;z-index:9998;display:none;gap:7px;
  padding:calc(8px + env(safe-area-inset-top,0px)) 0 0 calc(8px + env(safe-area-inset-left,0px))}
#arkBar.on{display:flex}
#arkBar a,#arkBar button{
  display:inline-block;text-decoration:none;cursor:pointer;
  font:600 12px/1 system-ui,-apple-system,'Apple SD Gothic Neo',sans-serif;
  color:#dfe6ef;background:rgba(18,22,30,.82);border:1px solid rgba(255,255,255,.22);
  border-radius:20px;padding:9px 14px;-webkit-tap-highlight-color:transparent;
  backdrop-filter:blur(4px)}
#arkBar a:active,#arkBar button:active{background:rgba(44,50,62,.94)}
</style>
<div id="arkBar"><a id="arkHome" href="/">← 목록</a><button id="arkRank" type="button">랭킹</button></div>
<script>
/* arcade-bar — 게임 목록으로 돌아가기 + 랭킹 열기.
   캔버스 화면마다 버튼을 그리는 대신 DOM 으로 한 번만 둔다 —
   어느 화면에 있든 같은 자리에 있고, 세 게임이 똑같이 동작한다.
   플레이 중에는 숨긴다. 안 그러면 조작하다 실수로 눌러 게임이 날아간다. */
(function(){
  'use strict';
  var bar = document.getElementById('arkBar');
  if (!bar) return;
  try { if (location.protocol === 'file:'){ bar.remove(); return; } } catch(e){ return; }

  document.getElementById('arkRank').addEventListener('click', function(){
    if (window.ArcadeRankUI) window.ArcadeRankUI.open();
  });

  // 플레이 중인가? 게임마다 알아내는 방법이 다르다.
  var TITLE_IDS = ['titleScreen', 'title', 'menuScreen', 'startScreen'];
  function playing(){
    try {
      if (window.__race && window.__race.state) return window.__race.state === 'PLAY';
      // 탄막 게임은 __game.state 로 노출한다 (screen 이 아니다). PAUSE 는 바를 보여 준다 —
      // 멈춰 있을 때 목록으로 나갈 길이 있어야 한다.
      var gs = window.__game && (window.__game.state || window.__game.screen);
      if (gs) return String(gs) === 'PLAY';
    } catch(e){}
    // DOM 기반 게임(줄넘기): 타이틀 화면이 보이면 플레이 중이 아니다
    var found = false;
    for (var i = 0; i < TITLE_IDS.length; i++){
      var t = document.getElementById(TITLE_IDS[i]);
      if (!t) continue;
      found = true;
      try { if (getComputedStyle(t).display !== 'none' && t.offsetParent !== null) return false; }
      catch(e){}
    }
    return found ? true : false;    // 판단 근거가 없으면 '플레이 중 아님' 으로 본다 (보여 준다)
  }
  function tick(){
    var hideIt = playing() || (window.ArcadeRankUI && window.ArcadeRankUI.isOpen());
    bar.classList.toggle('on', !hideIt);
  }
  tick();
  setInterval(tick, 350);
})();
</script>
"""

# 예전 patch-jumprope-home.sh 가 넣은 블록이 있으면 걷어낸다 (바가 대신한다)
n_old = 0
if 'arcade-home' in src:
    src2 = re.sub(r'\n?<style>\s*/\* arcade-home \*/[\s\S]*?</script>\s*', '\n', src, count=1)
    if src2 != src:
        src = src2; n_old = 1

# 예전에 넣은 블록이 있으면 걷어내고 항상 최신판을 다시 넣는다.
# '이미 있으니 넘어감' 으로 두면 이 스크립트를 새로 받아도 옛날 블록이 그대로 남는다.
n_up = 0
for tag in ('arcade-rankui', 'arcade-bar'):
    if tag not in src: continue
    src2 = re.sub(r'\n?<style>\s*/\* ' + tag + r'[\s\S]*?</script>\s*', '\n', src, count=1)
    if src2 != src:
        src = src2; n_up += 1

if 'arcade-rankui' in src or 'arcade-bar' in src:
    print('  ✗ 예전 블록을 걷어내지 못했습니다. 백업본으로 되돌린 뒤 알려 주세요.')
    sys.exit(3)

src = src.replace('</body>', OV + BAR + '</body>', 1)
io.open(path, 'w', encoding='utf-8').write(src)
print('  ✓ {0} — 좌측 상단에 [← 목록] [랭킹] 이 생깁니다.'.format(
      '최신판으로 교체했습니다' if n_up else '적용 완료')
      + (' (옛 링크는 제거했습니다)' if n_old else ''))
PYEOF

RC=$?
if [ "$RC" -eq 0 ]; then
  echo; echo "백업: $BAK"; echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  rm -f "$BAK"; exit "$RC"
fi
