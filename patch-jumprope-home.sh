#!/usr/bin/env bash
#
# 탭탭 줄넘기에 "게임 목록으로" 링크를 붙인다.
#
#   bash patch-jumprope-home.sh                      # /var/www/games/jumprope/index.html
#   bash patch-jumprope-home.sh /경로/index.html
#
# 게임 내부 구조를 모르므로 마크업을 건드리지 않는다.
# 화면 위에 링크 하나를 띄우고, 타이틀 화면일 때만 보이게 한다.
# (플레이 중에 보이면 실수로 눌러 게임이 날아간다)
set -euo pipefail
F="${1:-/var/www/games/jumprope/index.html}"
[ -f "$F" ] || { echo "파일을 찾을 수 없습니다: $F"; exit 1; }
BAK="$F.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$F" "$BAK"

python3 - "$F" <<'PYEOF'
import io, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()

if 'arcade-home' in src:
    print('  이미 적용돼 있습니다.')
    sys.exit(0)
if '</body>' not in src:
    print('  ✗ </body> 를 찾지 못했습니다.'); sys.exit(2)

BLOCK = """
<style>
/* arcade-home */
#arcadeHome{position:fixed;left:10px;top:10px;z-index:9999;
  display:none;text-decoration:none;font:600 12px/1 system-ui,-apple-system,sans-serif;
  color:#dfe6ef;background:rgba(20,24,32,.82);border:1px solid rgba(255,255,255,.22);
  border-radius:20px;padding:8px 13px;-webkit-tap-highlight-color:transparent;
  backdrop-filter:blur(4px)}
#arcadeHome:active{background:rgba(40,46,58,.92)}
</style>
<a id="arcadeHome" href="/">← 게임 목록</a>
<script>
/* arcade-home — 타이틀 화면에서만 보이는 "게임 목록으로" 링크.
   게임 마크업을 건드리지 않으려고, 타이틀 화면 요소가 보이는지만 주기적으로 확인한다.
   file:// 로 직접 열었으면 돌아갈 곳이 없으므로 아예 만들지 않는다. */
(function(){
  'use strict';
  var el = document.getElementById('arcadeHome');
  if (!el) return;
  try { if (location.protocol === 'file:'){ el.remove(); return; } } catch(e){ return; }
  // 타이틀 화면으로 쓸 만한 후보들 — 하나라도 보이면 링크를 띄운다
  var IDS = ['titleScreen', 'title', 'menuScreen', 'startScreen'];
  function titleVisible(){
    var found = false;
    for (var i = 0; i < IDS.length; i++){
      var t = document.getElementById(IDS[i]);
      if (!t) continue;
      found = true;                                   // 후보가 "있다"는 것을 기억해야 한다
      try { if (getComputedStyle(t).display !== 'none' && t.offsetParent !== null) return true; }
      catch(e){}
    }
    return found ? false : null;                      // 후보가 아예 없을 때만 '모르겠다'
  }
  function tick(){
    var v = titleVisible();
    // 판단할 근거가 없으면(null) 그냥 보여 준다 — 안 보이는 것보다 낫다
    el.style.display = (v === false) ? 'none' : 'block';
  }
  tick();
  setInterval(tick, 400);
})();
</script>
"""
src = src.replace('</body>', BLOCK + '</body>', 1)
io.open(path, 'w', encoding='utf-8').write(src)
print('  ✓ 적용 완료 — 타이틀 화면 좌측 상단에 "← 게임 목록" 링크가 생깁니다.')
PYEOF

RC=$?
if [ "$RC" -eq 0 ]; then
  echo; echo "백업: $BAK"; echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  rm -f "$BAK"; exit "$RC"
fi
