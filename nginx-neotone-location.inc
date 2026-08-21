# NEOTONE — 탄막게임(비행기) 릴레이로 넘기는 경로
#
# 이 파일은 server{} 블록 안에서 include 되어야 한다:
#     include /etc/nginx/conf.d/neotone-location.inc;
#
# 확장자를 .inc 로 둔 이유: conf.d/*.conf 는 http{} 로 자동 include 되는데
# location 은 server{} 안에만 올 수 있어서, 자동 include 대상에서 빼야 한다.
#
# ^~ 가 핵심이다. 이게 없으면 games.conf 의 `location ~* \.html$` 정규식이
# /plane/index.html 을 가로채서 404 가 된다 (실제로 재현 확인).
location ^~ /plane/ {
    proxy_pass         http://127.0.0.1:9000/;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection $connection_upgrade;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering    off;
    gzip_proxied       any;        # 269KB → 95KB
}
