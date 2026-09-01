#!/usr/bin/env bash
#
# 탭탭 줄넘기에 서버 공용 랭킹을 붙인다. (1인용 기록만 제출, 프로토콜 v2)
#
#   bash patch-jumprope-rank.sh                      # /var/www/games/jumprope/index.html
#   bash patch-jumprope-rank.sh /경로/index.html
#
# v2 에서는 판을 시작할 때 서버에서 1회용 런 토큰을 받아 두었다가 제출할 때 함께 낸다.
# 그래서 손댈 곳이 두 군데다:
#   ① 판 시작 (newGame) → ArcadeRank.start('jumprope')
#   ② 판 종료 (showOverScreen 의 prevBest 앞) → ArcadeRank.submit(...)
#
# 줄 번호가 아니라 코드 문자열(앵커)을 찾아서 넣는다. 필요한 앵커가 정확히 1개가 아니면
# 아무것도 바꾸지 않고 중단한다 — 잘못된 위치에 넣느니 실패하는 편이 낫다.
set -euo pipefail
F="${1:-/var/www/games/jumprope/index.html}"
[ -f "$F" ] || { echo "파일을 찾을 수 없습니다: $F"; exit 1; }
BAK="$F.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$F" "$BAK"

# set -e 때문에 python 이 실패하면 여기서 바로 죽어 백업 정리가 안 됐다.
# if 로 감싸면 set -e 가 적용되지 않아 실패 코드를 그대로 받아 처리할 수 있다.
if python3 - "$F" <<'PY'
import io, re, sys
path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()

# ── 이미 v2 가 들어가 있으면 아무것도 안 한다
if 'ArcadeRank.start(' in src and 'arcade-rank-proto: v2' in src:
    print('  이미 적용돼 있습니다 (v2).')
    sys.exit(0)

# ── 예전(v1) 헬퍼 블록은 걷어낸다. 'ArcadeRank 가 있으니 넘어감' 으로 두면
#    이 스크립트를 새로 받아도 토큰을 안 쓰는 옛 코드가 그대로 남는다.
helper_re = re.compile(r'\n?<script>\s*/\* ArcadeRank[\s\S]*?</script>\s*')
was_v1 = bool(helper_re.search(src))
src = helper_re.sub('\n', src)

need_submit = 'ArcadeRank.submit(' not in src
need_start  = 'ArcadeRank.start(' not in src

# ── 앵커 검증을 먼저 전부 끝낸다. 하나라도 어긋나면 파일에 손을 대지 않는다.
errs = []

# 판 시작 지점. 정찰(jumprope-recon.md 360줄)에서 확인한 유일한 시작 함수다.
# 실물 소스를 확인하지 못한 채 비슷해 보이는 다른 곳에 넣는 것보다, 못 찾으면 멈추는 편이 안전하다.
start_re = re.compile(r'function\s+newGame\s*\([^)]*\)\s*\{')
start_hits = list(start_re.finditer(src)) if need_start else []
if need_start and len(start_hits) != 1:
    errs.append(
        '  ✗ 시작 앵커(function newGame(mode){)를 %d개 찾았습니다. 1개여야 합니다.\n'
        '    v2 는 판이 시작될 때 서버에서 런 토큰을 받아야 하므로 이 지점이 반드시 필요합니다.\n'
        '    아래로 실제 시작 함수 이름을 확인한 뒤 이 스크립트의 start_re 를 고쳐 주세요:\n'
        "      grep -n 'function newGame' '%s'" % (len(start_hits), path))

# 판 종료 지점 (기존과 동일)
sub_re = re.compile(r'[ \t]*const\s+prevBest\s*=\s*BEST\[\s*key\s*\]\s*\|\|\s*0\s*;')
sub_hits = list(sub_re.finditer(src)) if need_submit else []
if need_submit and len(sub_hits) != 1:
    errs.append(
        '  ✗ 제출 앵커(const prevBest = BEST[key]||0;)를 %d개 찾았습니다. 1개여야 합니다.\n'
        '    서버에서 아래로 직접 확인해 주세요:\n'
        "      grep -n 'const prevBest' '%s'" % (len(sub_hits), path))

if '</body>' not in src:
    errs.append('  ✗ </body> 를 찾지 못했습니다.')

if errs:
    print('\n'.join(errs))
    print('  → 파일은 그대로 두었습니다 (아무것도 바꾸지 않았습니다).')
    sys.exit(2)

# ── 삽입. 뒤쪽부터 넣어야 앞쪽 오프셋이 밀리지 않는다.
edits = []

if need_submit:
    m = sub_hits[0]
    indent = re.match(r'[ \t]*', m.group(0)).group(0)
    # G.online 을 함께 보는 이유: 온라인에서는 G.mode 가 roster.length 로 덮어써져
    # 방에 혼자 남으면 G.mode===1 이 참이 된다. 그러면 온라인 점수가 1인 랭킹에 섞인다.
    edits.append((m.start(),
        indent + "try { if (!G.online && G.mode === 1 && window.ArcadeRank)\n"
      + indent + "        window.ArcadeRank.submit('jumprope', stats.score,\n"
      + indent + "                                 { combo: stats.bestCombo }); } catch(e){}\n"))

if need_start:
    m = start_hits[0]
    # 함수 여는 중괄호 바로 뒤. 여기서는 아직 솔로/온라인을 가릴 수 없다 —
    # 온라인은 이 다음에 G.mode 를 roster.length 로 덮어쓰기 때문이다.
    # 표를 미리 받아 두는 것 자체는 해가 없다 (안 내면 그냥 버려진다). 솔로 여부는 제출할 때 가린다.
    edits.append((m.end(),
        "\n  // 서버 랭킹 v2: 경과 시간을 서버가 토큰 발급 시각부터 재므로,"
        "\n  // 표는 판이 진짜로 시작하는 이 순간에 받는다. 실패해도 게임은 그대로 돈다."
        "\n  try { if (window.ArcadeRank) window.ArcadeRank.start('jumprope'); } catch(e){}\n"))

for at, text in sorted(edits, key=lambda e: -e[0]):
    src = src[:at] + text + src[at:]

# ── 공용 랭킹 헬퍼 — 게임 스크립트의 스코프를 모르므로 별도 블록으로 window 에 붙인다
HELPER = """
<script>
/* ArcadeRank — 세 게임 공용 서버 랭킹 (프로토콜 v2).
   같은 출처라서 /plane/ 프록시를 그대로 탄다(끝 슬래시가 접두사를 잘라낸다).
   ① start() 로 서버에서 신원(uid)과 1회용 런 토큰을 받고
   ② submit() 에서 그 토큰과 함께 점수를 낸다. uid 는 body 에 넣지 않는다 —
      서버가 토큰에서 꺼내 쓴다.
   실패해도 게임은 그대로 돌아야 하므로 전부 삼킨다 (거부 없이 항상 null 로 끝난다). */
window.ArcadeRank = (function(){
  'use strict';
  // arcade-rank-proto: v2   ← 이 표시로 재실행 시 '이미 v2' 를 판별한다
  var API = '/plane/api/rank';
  // 토큰은 이 클로저에만 둔다. localStorage 에 두면 새로고침·다른 탭에서 같은 표를
  // 다시 쓰게 되는데, 서버는 1회용으로 보고 'token used' 로 거절한다.
  var tok = '';
  function ls(k, v){
    try {
      if (v === undefined) return localStorage.getItem(k) || '';
      localStorage.setItem(k, v);
    } catch(e){}
    return '';
  }
  function who(){ return ls('arcade-name') || ls('overtake-name') || ''; }
  // 보낼 곳이 없는 상황(오프라인 file:// 플레이, fetch 없는 옛 브라우저)을 한 곳에서 판단한다.
  function off(){
    try { return location.protocol === 'file:' || typeof fetch !== 'function'; }
    catch(e){ return true; }
  }
  function post(url, body){
    try {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(body) })
        .then(function(r){ return r.json(); })
        .catch(function(){ return null; });
    } catch(e){ return Promise.resolve(null); }
  }
  return {
    get uid(){ return ls('arcade-uid'); },
    get name(){ return who(); },
    start: function(game){
      tok = '';                                  // 지난 판의 표가 남아 있으면 여기서 버린다
      if (off()) return Promise.resolve(null);
      var body = { game: game }, uid = ls('arcade-uid');
      if (uid) body.uid = uid;                   // 없으면 키째로 빼서 서버가 새로 발급하게 한다
      return post(API + '/start', body).then(function(d){
        if (!d || !d.ok) return null;            // 429(IP 한도) 포함 — 조용히 이번 판 제출을 포기한다
        // 서명 없는 옛 uid 는 서버가 무시하고 새로 발급한다. 그냥 덮어쓰면 된다.
        if (d.uid) ls('arcade-uid', d.uid);
        tok = d.tok || '';
        return d;
      }).catch(function(){ return null; });
    },
    submit: function(game, score, meta){
      if (off()) return Promise.resolve(null);
      var t = tok;
      // 먼저 비운다 — 종료 화면이 두 번 그려져도 같은 표로 두 번 나가지 않는다
      // (예전의 5초 중복 방지 타이머가 하던 일을 토큰 1회성이 대신한다).
      tok = '';
      if (!t) return Promise.resolve(null);      // 시작 때 표를 못 받았으면 낼 근거가 없다
      return post(API, { game: game, tok: t, score: Math.round(score),
                         name: who(), meta: meta || {} });
    }
  };
})();
</script>
"""
src = src.replace('</body>', HELPER + '</body>', 1)

io.open(path, 'w', encoding='utf-8').write(src)
print('  ✓ %s — 1인용(G.mode===1, 온라인 아님) 기록만 서버 랭킹에 올립니다.'
      % ('v1 헬퍼를 v2 로 교체했습니다' if was_v1 else '적용 완료'))
PY
then
  echo; echo "백업: $BAK"; echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  RC=$?
  rm -f "$BAK"
  exit "$RC"
fi
