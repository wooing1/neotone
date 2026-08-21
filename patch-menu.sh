#!/usr/bin/env bash
#
# 게임 선택 화면의 "비행기 게임" 카드를 '준비 중' → 실제 서비스로 바꾼다.
#
#   bash patch-menu.sh                          # /var/www/games/index.html
#   bash patch-menu.sh /경로/index.html          # 다른 파일
#
# 원본은 같은 폴더에 index.html.bak.<날짜시각> 으로 백업합니다.
# 여러 번 돌려도 안전합니다 (이미 적용돼 있으면 아무것도 하지 않습니다).

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

m = re.search(r'<a[^>]*href="/plane/"[\s\S]*?</a>', src)
if not m:
    print('  ✗ /plane/ 카드를 찾지 못했습니다. 파일을 확인해 주세요.')
    sys.exit(2)

card = m.group(0)
new  = card

# ① '준비 중' 배지 → '2~4인' (soon 클래스를 떼서 색도 활성 상태로)
new = re.sub(r'class="tag\s+soon"\s*>\s*[^<]*<', 'class="tag">2~4인<', new)

# ② 설명 문구
new = re.sub(r'(<p\s+class="d"\s*>)[^<]*(</p>)',
             r'\g<1>탄막 슈팅 · 최대 4인 협동. 방을 만들어 친구와 함께.\g<2>',
             new)

if new == card:
    print('  변경할 내용이 없습니다 (이미 적용된 상태로 보입니다).')
    sys.exit(0)

io.open(path, 'w', encoding='utf-8').write(src[:m.start()] + new + src[m.end():])
print('  ✓ 적용 완료')
print()
print('  before: ' + re.sub(r'\s+', ' ', card).strip())
print('  after : ' + re.sub(r'\s+', ' ', new).strip())
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
