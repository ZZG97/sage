# RSSHub Configuration

Use this file when modifying, debugging, or validating RSSHub deployments.

## Local Defaults

- First inspect the deployment; do not assume the path exists.
- The user's current local deployment may be under `~/deploy/rsshub`.
- Prefer `docker-compose` if Docker Compose v2 (`docker compose`) is unavailable.
- Do not print raw `.env` values. Redact cookies, tokens, passwords, keys, auth strings, and secrets.

## Inspection Checklist

Run lightweight reads first:

```bash
find ~/deploy -maxdepth 4 \( -iname '*rsshub*' -o -name 'docker-compose*.yml' -o -name '.env' \) -print
ls -la ~/deploy/rsshub
sed -n '1,220p' ~/deploy/rsshub/docker-compose.yml
docker-compose ps
curl -sS --max-time 10 http://localhost:1200/healthz
```

When showing `.env`, redact secrets:

```bash
sed -E 's/(COOKIE|COOKIES|TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH)=.*/\1=<redacted>/I' .env
```

## Minimal Local RSSHub

For a single local instance, prefer the bundled Chromium image when Puppeteer routes are needed:

```yaml
services:
    rsshub:
        image: diygod/rsshub:chromium-bundled
        restart: always
        ports:
            - '1200:1200'
        environment:
            NODE_ENV: production
        healthcheck:
            test: ['CMD', 'curl', '-f', 'http://localhost:1200/healthz']
            interval: 30s
            timeout: 10s
            retries: 3
```

Keep existing cookie env entries if already present, for example `ZHIHU_COOKIES: ${ZHIHU_COOKIES}`.

## What To Avoid Locally

- Do not add Redis by default. RSSHub memory cache is enough for local single-instance use.
- Do not add browserless unless the user wants a separate browser service or the bundled image is unsuitable.
- Do not add extra volumes or networks unless the deployment actually needs them.

Redis is useful for shared or persistent cache in production. For RSSHub local cache, losing cache only means refetching feeds.

## Puppeteer Routes

Routes that render pages or execute JavaScript require Chrome/Puppeteer. Symptoms:

```text
Could not find Chrome
```

Fix with one of:

- `diygod/rsshub:chromium-bundled`, simplest for local single-instance deployment.
- `browserless/chrome` plus `PUPPETEER_WS_ENDPOINT`, useful for multi-service browser pools.

## X / Twitter Routes

The user timeline route is:

```text
http://localhost:1200/twitter/user/<username>
```

Current RSSHub requires Twitter/X authentication for this route. Preferred config is `TWITTER_AUTH_TOKEN`, a
comma-separated list of `auth_token` cookies from logged-in Twitter Web. Add it to `.env`, pass it through
`docker-compose.yml`, restart RSSHub, then validate the target route. Do not print the token.

The old `TWITTER_USERNAME` / `TWITTER_PASSWORD` / `TWITTER_AUTHENTICATION_SECRET` login flow no longer works since
Twitter mobile client attestation was added in October 2025. Developer API credentials are another option, but require
paid Twitter API access.

## Validation

After changes:

```bash
docker-compose pull rsshub
docker-compose up -d rsshub
docker-compose ps
curl -sS --max-time 10 http://localhost:1200/healthz
```

Then test one route that exercises the changed capability. For Xueqiu user dynamics:

```bash
curl -sS --max-time 45 http://localhost:1200/xueqiu/user/8152922548 | head -c 1200
curl -sS --max-time 30 http://localhost:1200/xueqiu/user/8152922548/0 | rg -o '<title>[^<]+'
```

Report the changed file, restarted service, health status, and tested feed URL.
