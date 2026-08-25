#!/usr/bin/env bash
#
# 탭탭 줄넘기에 서버 공용 랭킹을 붙인다. (1인용 기록만 제출)
#
#   bash patch-jumprope-rank.sh                      # /var/www/games/jumprope/index.html
#   bash patch-jumprope-rank.sh /경로/index.html
#
# 줄 번호가 아니라 코드 문자열(앵커)을 찾아서 넣는다. 앵커가 정확히 1개가 아니면
# 아무것도 바꾸지 않고 중단한다 — 잘못된 위치에 넣느니 실패하는 편이 낫다.
set -euo pipefail
F="${1:-/var/www/games/jumprope/index.html}"
[ -f "$F" ] || { echo "파일을 찾을 수 없습니다: $F"; exit 1; }
BAK="$F.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$F" "$BAK"

python3 - "$F" <<'PY'
import io, re, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()

if 'ArcadeRank' in src:
    print('  이미 적용돼 있습니다.')
    sys.exit(0)

# ── 앵커 검증 — 여기서 걸리면 아무것도 안 바꾼다
anchor = re.compile(r'[ \t]*const\s+prevBest\s*=\s*BEST\[\s*key\s*\]\s*\|\|\s*0\s*;')
hits = list(anchor.finditer(src))
if len(hits) != 1:
    print('  ✗ 앵커(const prevBest = BEST[key]||0;)를 %d개 찾았습니다. 1개여야 합니다.' % len(hits))
    print('    서버에서 아래로 직접 확인해 주세요:')
    print("      grep -n 'const prevBest' '%s'" % path)
    sys.exit(2)
if '</body>' not in src:
    print('  ✗ </body> 를 찾지 못했습니다.'); sys.exit(3)

m = hits[0]
indent = re.match(r'[ \t]*', m.group(0)).group(0)

# ── 1. 제출 한 줄 — 앵커 바로 앞
#    G.online 을 함께 보는 이유: 온라인에서는 G.mode 가 roster.length 로 덮어써져
#    방에 혼자 남으면 G.mode===1 이 참이 된다. 그러면 온라인 점수가 1인 랭킹에 섞인다.
line = (indent + "try { if (!G.online && G.mode === 1 && window.ArcadeRank)\n"
        + indent + "        window.ArcadeRank.submit('jumprope', stats.score,\n"
        + indent + "                                 { combo: stats.bestCombo, spins: stats.spins }); } catch(e){}\n")
src = src[:m.start()] + line + src[m.start():]

# ── 2. 공용 랭킹 헬퍼 — 게임 스크립트의 스코프를 모르므로 별도 블록으로 window 에 붙인다
HELPER = """
<script>
/* ArcadeRank — 세 게임 공용 서버 랭킹.
   같은 출처라서 /plane/ 프록시를 그대로 탄다(끝 슬래시가 접두사를 잘라낸다).
   실패해도 게임은 그대로 돌아야 하므로 전부 삼킨다. */
window.ArcadeRank = (function(){
  'use strict';
  var API = '/plane/api/rank', last = {};
  function ls(k, v){
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); }
    catch(e){ return null; }
  }
  var uid = ls('arcade-uid');
  if (!uid){
    uid = Math.random().toString(36).slice(2,10) + Date.now().toString(36).slice(-4);
    ls('arcade-uid', uid);
  }
  function who(){ return ls('arcade-name') || ls('overtake-name') || ''; }
  return {
    uid: uid,
    get name(){ return who(); },
    submit: function(game, score, meta){
      try {
        // 같은 판이 두 번 제출되는 것을 막는다 (종료 화면이 두 번 그려지는 경우)
        if (location.protocol === 'file:') return Promise.resolve(null);
        var k = game + ':' + Math.round(score), now = Date.now();
        if (last[k] && now - last[k] < 5000) return Promise.resolve(null);
        last[k] = now;
        return fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ game: game, score: Math.round(score), name: who(),
                                 uid: uid, meta: meta || {} }) })
          .then(function(r){ return r.json(); }).catch(function(){ return null; });
      } catch(e){ return Promise.resolve(null); }
    }
  };
})();
</script>
"""
src = src.replace('</body>', HELPER + '</body>', 1)

io.open(path, 'w', encoding='utf-8').write(src)
print('  ✓ 적용 완료 — 1인용(G.mode===1, 온라인 아님) 기록만 서버 랭킹에 올립니다.')
PY

RC=$?
if [ "$RC" -eq 0 ]; then
  echo; echo "백업: $BAK"; echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  rm -f "$BAK"; exit "$RC"
fi
