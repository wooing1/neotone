# NEOTONE — 네이버 클라우드 서버에 직접 올리기 (로그인 방식)

대상 서버: `110.165.17.81` (Rocky 8.8, root, PEM 키)
**HTTPS는 쓰지 않습니다.** 릴레이는 `ws://` 로 붙고, 페이지도 `http://` 라 섞임 문제가 없습니다.

---

## ★ 이 서버의 실제 상태 (2026-08-21 확인 완료 → **방법 A** 로 진행)

`ss -lntp` 로 확인한 결과입니다.

| 항목 | 실제 | 판단 |
|---|---|---|
| 80 (공개) | nginx 1.14.1 | 줄넘기 게임. **건드리지 않습니다** |
| 127.0.0.1:8080 | nginx (내부) | 위와 한 세트. 건드리지 않습니다 |
| 127.0.0.1:20241 | cloudflared | 터널. 건드리지 않습니다 |
| 22 | sshd | — |
| 111 / 5355 | rpcbind / systemd-resolve | OS 기본 |
| **3000** | **비어 있음** | ← NEOTONE 이 여기로 갑니다 |
| Node.js | **설치 안 됨** | 설치해도 **깨질 앱이 없습니다** |

**결론: 방법 A (3000 포트) 로 갑니다.**

- 3000 은 ACG 노출포트에 이미 있어서 **콘솔 작업이 필요 없습니다**
- nginx·cloudflared·줄넘기 게임과 **접점이 0** 입니다 (포트·파일·서비스 전부 별개)
- Node 가 아직 없으므로 **버전 충돌 위험도 없습니다.** 원래 이게 제일 위험한 지점이었는데,
  이 서버에는 Node 를 쓰는 앱이 없어서 그냥 설치하면 됩니다
- 아래 3장(파일 올리기) → 2장(방법 A) 순서만 하면 끝입니다.
  방법 B·C 는 참고용으로 남겨 둡니다

---

## 0. 참고 — 기존 줄넘기 게임과 겹칠 수 있는 곳은 3군데입니다

| 겹칠 수 있는 것 | 위험도 | 이 안내서의 처리 |
|---|---|---|
| **포트** | 높음 | 0단계에서 확인하고, 비어 있는 포트를 씁니다 |
| **Node.js 버전** | **가장 높음** | **이미 깔려 있으면 손대지 않습니다** |
| 파일 위치 · 서비스 이름 | 없음 | `/opt/neotone`, `neotone.service` 로 분리 |

> ⚠️ **Node 를 건드리면 줄넘기 게임이 깨질 수 있습니다.**
> Rocky 8 은 `dnf module` 로 Node 버전(스트림)을 관리합니다. 여기서
> `dnf module reset nodejs` → `enable nodejs:20` 을 하면 **이미 돌고 있는 앱의 Node 가
> 통째로 올라갑니다.** 그래서 아래 순서에서는 `node` 가 있으면 **있는 걸 그대로 씁니다.**
> NEOTONE 은 Node 12 이상이면 어떤 버전에서도 돕니다 (내장 모듈만 씁니다).

### 확인 명령 — 로그인해서 이것만 먼저 돌려보세요

```bash
ssh -i ~/Downloads/키파일.pem root@110.165.17.81
```

```bash
# ① 무엇이 어느 포트에 떠 있나  ← 제일 중요
ss -lntp

# ② 돌고 있는 서비스 목록
systemctl list-units --type=service --state=running --no-pager | head -30

# ③ Node 가 이미 있나 (있으면 그대로 씁니다)
command -v node && node -v || echo "Node 없음"

# ④ nginx 가 있나 (방법 C 에서 씀)
command -v nginx && nginx -v 2>&1 || echo "nginx 없음"
```

**①의 결과를 보고 갈 길을 정합니다.**

- `3000` 이 비어 있다 → **방법 A**
- `3000` 을 줄넘기 게임이 쓰고 있다 → **방법 B** (다른 포트 + ACG 추가) 또는 **방법 C** (nginx 뒤에 얹기)

---

## 1. 파일 올리기 (세 방법 공통)

**로그인 전에, 내 Mac 터미널에서** 실행합니다.

```bash
cd ~/Documents/game_test01
scp -i ~/Downloads/키파일.pem index.html server.js root@110.165.17.81:/tmp/
```

그다음 서버에 로그인해서:

```bash
mkdir -p /opt/neotone
mv /tmp/index.html /tmp/server.js /opt/neotone/
ls -la /opt/neotone
```

Node 가 **없을 때만** 설치합니다 (있으면 이 블록을 건너뛰세요):

```bash
if ! command -v node >/dev/null; then
  dnf -y module enable nodejs:20 || dnf -y module enable nodejs:18
  dnf -y install nodejs
fi
node -v
```

---

## 2. 방법 A — 3000 포트가 비어 있을 때 (제일 간단)

```bash
PORT=3000
NODE=$(command -v node)

cat > /etc/systemd/system/neotone.service <<UNIT
[Unit]
Description=NEOTONE danmaku relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/neotone
ExecStart=${NODE} /opt/neotone/server.js ${PORT}
Restart=always
RestartSec=2
Environment=NEOTONE_MAX_SOCKETS=64
Environment=NEOTONE_MAX_ROOMS=16
StandardOutput=append:/var/log/neotone.log
StandardError=append:/var/log/neotone.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now neotone
systemctl status neotone --no-pager
```

방화벽 열고 확인:

```bash
firewall-cmd --permanent --add-port=3000/tcp && firewall-cmd --reload
curl -s http://127.0.0.1:3000/health; echo
```

`{"ok":true,...}` 가 나오면 서버 안에서는 성공입니다.
**밖에서** 되는지는 내 PC 브라우저나 터미널에서:

```bash
curl -s http://110.165.17.81:3000/health; echo
```

여기서 응답이 없으면 **ACG(보안그룹) 인바운드**에 TCP 3000 이 없는 경우입니다.
(스크린샷 노출포트에 3000 이 있으니 아마 그냥 됩니다.)

→ 접속 주소: **`http://110.165.17.81:3000/`**

---

## 3. 방법 B — 3000 이 줄넘기 게임일 때 (다른 포트 쓰기)

방법 A 와 똑같고 `PORT` 만 바꿉니다. 예: `PORT=3100`

```bash
PORT=3100     # ← 이 값만 바꿔서 방법 A 를 그대로 진행
```

그리고 **네이버 클라우드 콘솔 → ACG → 인바운드 규칙에 TCP 3100 추가**가 필요합니다.
(안 열면 서버 안에서는 되는데 밖에서 안 됩니다.)

→ 접속 주소: **`http://110.165.17.81:3100/`**

---

## 4. 방법 C — ACG 를 건드리고 싶지 않을 때 (기존 nginx 뒤에 얹기)

이미 80 포트에 nginx 가 있고 거기서 줄넘기 게임을 서빙하고 있다면,
**같은 80 포트의 `/neotone/` 경로**에 얹을 수 있습니다. ACG 추가가 필요 없습니다.

먼저 NEOTONE 을 **바깥에 노출되지 않는 내부 포트**로 띄웁니다 (방법 A 에서 `PORT=9000`,
방화벽 개방은 **하지 않습니다**).

그다음 nginx 설정을 넣습니다. **기존 파일을 고치기 전에 백업하세요.**

```bash
cp -a /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak.$(date +%F)
ls /etc/nginx/conf.d/
```

WebSocket 업그레이드용 map 을 별도 파일로 추가합니다 (기존 설정과 충돌하지 않습니다):

```bash
cat > /etc/nginx/conf.d/00-neotone-map.conf <<'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
```

그리고 **줄넘기 게임을 서빙하는 `server { ... }` 블록 안에** 아래 `location` 을 추가합니다
(보통 `/etc/nginx/conf.d/*.conf` 나 `nginx.conf` 안에 있습니다):

```nginx
    location /neotone/ {
        proxy_pass         http://127.0.0.1:9000/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection $connection_upgrade;
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
        proxy_buffering    off;
    }
```

검사하고 반영:

```bash
nginx -t && systemctl reload nginx
curl -s http://127.0.0.1/neotone/health; echo
```

→ 접속 주소: **`http://110.165.17.81/neotone/`**

> 게임이 서브경로에서도 릴레이를 제대로 찾도록 만들어 두었습니다
> (현재 페이지 디렉터리 기준으로 `ws` 주소를 만듭니다 → `/neotone/ws`).
> 리버스 프록시 환경에서 4인 접속·동기화까지 실제로 검증했습니다.

---

## 5. 잘 떴는지 최종 확인

```bash
systemctl status neotone --no-pager      # active (running) 이어야 함
curl -s http://127.0.0.1:<포트>/health   # {"ok":true,...}
tail -f /var/log/neotone.log             # 누가 들어오는지 실시간
```

브라우저로 접속 주소를 열고 → `ONLINE CO-OP` → `CREATE ROOM`.
**대기실에 초록색으로 `릴레이 서버 경유` 가 보이면 제대로 붙은 겁니다.**

---

## 6. 운영

```bash
systemctl restart neotone     # 재시작
systemctl stop neotone        # 중지
systemctl disable --now neotone   # 자동시작까지 해제
journalctl -u neotone -n 50 --no-pager   # 오류 로그
```

**게임을 새 버전으로 올릴 때** (내 Mac 에서):

```bash
scp -i ~/Downloads/키파일.pem index.html root@110.165.17.81:/opt/neotone/
ssh -i ~/Downloads/키파일.pem root@110.165.17.81 'systemctl restart neotone'
```

`server.js` 가 시작할 때 `index.html` 을 읽으므로 **재시작이 필요합니다.**

## 7. 깨끗하게 지우기 (줄넘기 게임에는 영향 없음)

```bash
systemctl disable --now neotone
rm -f /etc/systemd/system/neotone.service
systemctl daemon-reload
rm -rf /opt/neotone /var/log/neotone.log
firewall-cmd --permanent --remove-port=3000/tcp && firewall-cmd --reload   # 열었다면
# 방법 C 를 썼다면 nginx 의 location /neotone/ 블록과
# /etc/nginx/conf.d/00-neotone-map.conf 도 지우고 systemctl reload nginx
```

---

## 참고 — 이 릴레이에 대해

- **인증이 없습니다.** 동시 접속 64명 · 동시 방 16개로 한도를 걸어 두었습니다
  (`Environment=NEOTONE_MAX_SOCKETS=` / `NEOTONE_MAX_ROOMS=` 로 조정)
- 방 코드는 4자리입니다. 남이 우연히 같은 코드로 들어올 수 있습니다
- 대역폭은 4인 기준 서버 업로드 약 0.7Mbps 수준입니다 (실측 초반 웨이브 1~5KB/s)
- 의존성이 0개입니다. `npm install` 이 필요 없고 `node_modules` 도 만들지 않습니다
