# Sourced before each Bash command of a view build's session (dev.view_env): a proxy that refuses every connection, which
# the common download tools and HTTP libraries honour. Loopback stays direct, for the view's check.
for v in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do export "$v=http://127.0.0.1:9"; done
export NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1 NODE_USE_ENV_PROXY=1
