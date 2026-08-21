#!/usr/bin/env bash
#
# 게임 선택 화면에 "쌩쌩 추월" 카드를 추가한다.
#
#   bash patch-menu-race.sh                     # /var/www/games/index.html
#   bash patch-menu-race.sh /경로/index.html
#
# 기존 카드들과 같은 마크업/클래스를 그대로 쓰므로 스타일이 저절로 맞습니다.
# 원본은 index.html.bak.<날짜시각> 으로 백업하고, 여러 번 돌려도 안전합니다.

set -euo pipefail
F="${1:-/var/www/games/index.html}"

if [ ! -f "$F" ]; then
  echo "파일을 찾을 수 없습니다: $F"
  exit 1
fi

BAK="$F.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$F" "$BAK"

python3 - "$F" <<'PY'
import io, re, sys

path = sys.argv[1]
src = io.open(path, encoding='utf-8').read()

if '/race/' in src:
    print('  이미 추가돼 있습니다.')
    sys.exit(0)

# 마지막 카드(<a ... class="card"> ... </a>) 뒤에 끼워 넣는다.
cards = list(re.finditer(r'<a[^>]*class="card"[\s\S]*?</a>', src))
if not cards:
    print('  ✗ 카드(<a class="card">)를 찾지 못했습니다. 파일을 확인해 주세요.')
    sys.exit(2)

last = cards[-1]

# 마지막 카드가 시작하는 줄의 들여쓰기를 그대로 흉내낸다
line_start = src.rfind('\n', 0, last.start()) + 1
indent = src[line_start:last.start()]
if indent.strip():
    indent = ''

card = (
    '\n' + indent + '<a href="/race/" class="card">\n'
    + indent + '  <div class="emoji">🚗</div>\n'
    + indent + '  <div>\n'
    + indent + '    <p class="t">쌩쌩 추월<span class="tag">1인</span></p>\n'
    + indent + '    <p class="d">앞 차를 추월하며 오래 버티기. 브레이크는 없습니다.</p>\n'
    + indent + '  </div>\n'
    + indent + '</a>\n'
)

out = src[:last.end()] + card + src[last.end():]
io.open(path, 'w', encoding='utf-8').write(out)
print('  ✓ 추가 완료 — /race/ 카드를 마지막 카드 뒤에 넣었습니다.')
PY

RC=$?
if [ "$RC" -eq 0 ]; then
  echo
  echo "백업: $BAK"
  echo "되돌리려면:  cp -a \"$BAK\" \"$F\""
else
  rm -f "$BAK"
  exit "$RC"
fi
