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
if not todo and 'arcade-rank' in src:
    print('  이미 적용돼 있습니다 ({0}개 카드 전부).'.format(len(cards)))
    sys.exit(0)

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
  var uid = ls('arcade-uid');
  if (!uid){
    uid = Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
    ls('arcade-uid', uid);
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
    for (var i = 0; i < g.top.length; i++) ol.appendChild(row(g.top[i], g.top[i].uid === uid));
    box.appendChild(ol);
    if (g.me && g.me.rank > g.top.length){
      var d2 = document.createElement('div'); d2.className = 'rkw';
      d2.textContent = '내 기록 ' + g.me.rank + '위 · ' + g.me.disp;
      box.appendChild(d2);
    }
  }
  function load(){
    var boxes = document.querySelectorAll('.rk');
    fetch(API + '?n=3&uid=' + encodeURIComponent(uid), { cache: 'no-store' })
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

if 'arcade-rank —' not in src:
    src = src.replace('</body>', JS + '</body>', 1) if '</body>' in src else src + JS

io.open(path, 'w', encoding='utf-8').write(src)
print('  ✓ 적용 완료 — 이번에 붙인 카드: {0} / 전체 카드 {1}개'.format(
      ', '.join(found) if found else '(없음)', len(cards)))
PYEOF

RC=$?
if [ "$RC" -eq 0 ]; then
  echo; echo "백업: $BAK"; echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  rm -f "$BAK"; exit "$RC"
fi
