# 배포 명령 — 2026-08-25 (2차: 목록 바 + 통합 랭킹 + 아슬아슬 점수 반영)

서버에 SSH 로 들어가서 **root** 로 아래를 순서대로 실행하세요.
전부 백업을 남기고, 여러 번 돌려도 안전합니다.

커밋을 고정해서 받습니다. `main` 을 쓰면 raw.githubusercontent 캐시(약 5분) 때문에
직전 버전이 내려올 수 있어서, 방금 올린 커밋 해시를 직접 지정합니다.

```bash
R=https://raw.githubusercontent.com/wooing1/neotone/61e189c
TS=$(date +%Y%m%d-%H%M%S)
```

이번에 들어가는 것
- **세 게임 모두 좌측 상단에 `← 목록` `랭킹` 바** — 어느 화면에서도 게임 선택으로 나갈 수 있습니다
  (플레이 중에는 자동으로 숨습니다. 조작하다 실수로 누르는 걸 막기 위해서입니다)
- **통합 랭킹 화면** — 세 게임 TOP 10 을 탭으로 넘겨 보고, 내 기록이 있으면 표시됩니다.
  메인화면과 세 게임 어디서든 같은 화면이 뜹니다
- 랭킹 이름 입력칸 글꼴 16px — iOS 가 포커스 시 페이지를 확대하던 문제 (캔버스 게임엔 치명적)
- 자동차 게임 타이틀에 `내 기록` 버튼 분리 (`랭킹` 은 통합 화면)
- **쌩쌩 추월 — 아슬아슬이 기록에 반영됩니다.** 지금까지는 세기만 하고 점수에 1미터도
  안 붙었습니다. 이제 스칠 때마다 보너스 거리가 붙고, 빠를수록(최대 x2.2) ·
  연속으로 스칠수록(최대 x2.0) 커집니다. 기록 = 주행거리 + 아슬아슬 보너스
- 쌩쌩 추월 계기판이 1 km 를 넘어도 1 m 단위로 표시됩니다 (전에는 10 m 단위로 뭉개져서
  제일 빠를 때 오히려 숫자가 느리게 도는 것처럼 보였습니다)

> **패치 스크립트가 바뀌었습니다.** 이제 이미 적용된 상태에서 다시 돌리면
> 예전 블록을 걷어내고 **최신판으로 갈아 끼웁니다** (전에는 "이미 적용됨" 으로 건너뛰었습니다).
> `patch-jumprope-home.sh` 는 `patch-jumprope-ui.sh` 로 대체됐습니다 — 예전 걸 이미 돌렸어도
> 새 스크립트가 알아서 걷어냅니다.

---

## 1. 탄막 게임(/plane/)

```bash
cd /opt/neotone
cp -a index.html index.html.bak.$TS
curl -fsSL -o index.html $R/index.html
wc -c index.html                       # 298462 바이트
systemctl restart neotone
sleep 1
curl -s localhost:9000/health; echo
```

서버(`server.js`)와 `autoplay.html` 은 이번에 안 바뀌었습니다. 1차 배포를 아직 안 하셨다면
아래도 같이 받으세요.

```bash
cp -a server.js server.js.bak.$TS
curl -fsSL -o server.js     $R/server.js       # 23238
curl -fsSL -o autoplay.html $R/autoplay.html   # 16997
node --check server.js && echo "server.js 문법 OK"
systemctl restart neotone
```

`{"ok":true, ... ,"ranks":{...}}` 가 나오면 성공입니다.
랭킹 저장 위치는 `/var/lib/neotone/ranks.json` — 게임 폴더 밖이라 재배포해도 안 날아갑니다.

## 2. 자동차 게임(/race/)

```bash
cp -a /var/www/games/race/index.html /var/www/games/race/index.html.bak.$TS
curl -fsSL -o /var/www/games/race/index.html $R/race-index.html
wc -c /var/www/games/race/index.html          # 95996 바이트
```

## 3. 메인화면 + 줄넘기

```bash
curl -fsSL -o /tmp/patch-menu-rank.sh    $R/patch-menu-rank.sh      # 19832
curl -fsSL -o /tmp/patch-jumprope-ui.sh  $R/patch-jumprope-ui.sh    # 14794

bash /tmp/patch-menu-rank.sh       # 카드 TOP 3 + '전체 랭킹 보기' + 통합 랭킹 화면
bash /tmp/patch-jumprope-ui.sh     # 줄넘기에 [← 목록] [랭킹] 바 + 통합 랭킹 화면
```

`✓ 최신판으로 교체했습니다` 또는 `✓ 적용 완료` 가 나오면 성공입니다.
`✗` 가 나오면 **아무것도 바꾸지 않고 중단**한 것이니 그 문구를 그대로 알려 주세요.

줄넘기 점수 제출(`patch-jumprope-rank.sh`)은 1차 배포에 이미 들어갔습니다. 안 하셨다면:

```bash
curl -fsSL -o /tmp/patch-jumprope-rank.sh $R/patch-jumprope-rank.sh
grep -c 'const prevBest' /var/www/games/jumprope/index.html   # 1 이어야 합니다
bash /tmp/patch-jumprope-rank.sh
```

## 4. 확인

```bash
curl -s -o /dev/null -w "탄막      %{http_code}\n" localhost:9000/
curl -s -o /dev/null -w "메인      %{http_code}\n" localhost/
curl -s -o /dev/null -w "자동차    %{http_code}\n" localhost/race/
curl -s -o /dev/null -w "줄넘기    %{http_code}\n" localhost/jumprope/
curl -s "localhost:9000/api/rank" | head -c 200; echo

# 네 곳 모두에 랭킹 화면이 들어갔는지
for f in /var/www/games/index.html /var/www/games/race/index.html \
         /var/www/games/jumprope/index.html /opt/neotone/index.html; do
  printf "%-42s rankui=%s bar=%s\n" "$f" \
    "$(grep -c arcade-rankui $f)" "$(grep -c arcade-bar $f)"
done
```

기대값 — 메인은 `rankui=2 bar=0` (메인 자체가 목록이라 바가 없습니다),
나머지 셋은 `rankui=2 bar=2`.

브라우저에서:

- 메인       `https://<터널주소>/`
- 탄막       `https://<터널주소>/plane/`
- 자동차     `https://<터널주소>/race/`
- 자동 플레이 `https://<터널주소>/plane/autoplay.html`

---

## 되돌리기

```bash
cd /opt/neotone && cp -a index.html.bak.$TS index.html && systemctl restart neotone
cp -a /var/www/games/race/index.html.bak.$TS /var/www/games/race/index.html
```

메인·줄넘기 패치는 각각 `index.html.bak.<날짜시각>` 을 같은 폴더에 남깁니다.
