---
name: rental-search
description: Research and shortlist rental housing, especially Beijing/Beike/opencli workflows. Use this skill whenever the user asks about 租房, 房源, 贝壳租房, 链家租房, 大钟寺/海淀租房, 两居室, 租金筛选, 通勤找房, or wants rental listings ranked or filtered. This skill captures the current opencli Beike URL tricks, known filter codes, caveats, and route-planning extension points.
---

# 租房信息查询

## Scope

Help Laozhang query rental listings, usually in Beijing, using local `opencli` first. Prefer fast, low-risk read-only commands. Treat listings as volatile; always state query time if reporting concrete房源.

Current reliable baseline:

```bash
opencli ke zufang --city bj --district '<area-slug>/<filters>' --limit 20 -f json
```

`opencli ke zufang` is a browser-backed Beike adapter. It scrapes the listing page DOM and returns:

- `title`
- `community`
- `area`
- `layout`
- `price`
- `url`

## Detail Page Reading

Use a browser, not `curl`, when concrete listing details are needed. Beike detail pages can require a logged-in browser session and `curl` may return only a login shell or miss key fields.

For short-listed listings, open the detail URL in the browser and read the visible DOM for:

- maintenance date and verification id
- price, payment method, deposit, service fee, intermediary fee
- floor, elevator, orientation, decoration, utilities, heating, gas
- move-in date, viewing availability, lease term
- subway distance and nearby transport

Keep this read-only: do not favorite, book viewings, submit forms, or expose account/contact data without explicit user confirmation.

## Important Implementation Detail

The installed adapter does not validate `district`. It simply inserts it into the URL path:

```js
path = `/zufang/${kwargs.district}/`;
```

Therefore `district` can be a Beike area slug plus filter path, not just an administrative district:

```bash
opencli ke zufang --city bj --district 'zaojunmiao/rt200600000001l1rp6' --limit 20 -f json
```

Do not assume this is an official opencli interface. It is a pragmatic URL-path trick and must be verified with returned listings.

## Known Beike URL Codes

Observed and verified on Beijing Beike rental pages:

- `rt200600000001`: 整租
- `l1`: 两居
- `rp5`: 5000-6000 元/月
- `rp6`: 6000-8000 元/月
- `rp7`: 8000-20000 元/月 or higher bucket, verify returned prices
- `rp5rp6`: 5000-8000 元/月 by combining the two buckets

Unreliable:

- `--min-price` / `--max-price`: opencli builds custom `rp{min}t{max}` URLs, but these often return empty or mixed results.
- `rp5000t8000`: observed to include out-of-budget listings such as 8800/9600; avoid unless followed by strict local filtering.
- `--district haidian`: too broad and can return unexpected/fallback results.

Always parse the numeric price and filter locally when the budget matters.

## Beijing Area Slugs

For 大钟寺/皂君庙 nearby searches, use these first:

- `zaojunmiao`: closest observed slug; returns 大钟寺甲8号院, 皂君东里, 皂君西里, 皂君庙丙4号院, 农科院, 鑫雅苑, 文林大厦.
- `zhichunlu`: nearby, returns 知春嘉园, 太月园, 罗庄, 蓟门.
- `shuangyushu`: nearby, returns 双榆树东里, 双榆树北路6号院, 青云北区, 知春里.
- `beitaipingzhuang`: broader south/east option, returns 北影小区, 黄亭子小区, 北太平庄路, 花园路.

`dazhongsi` was tried and is not the best slug. Prefer `zaojunmiao` for 大钟寺附近.

For 北苑 / 朝阳北苑 searches:

- `beiyuan2`: verified Beike slug for 北苑; returns 北苑家园、华贸城、来北家园、润泽悦溪, etc.
- `beiyuan`: unreliable; observed to return citywide/fallback results. Avoid it unless re-verified.

## Query Recipes

大钟寺/皂君庙附近整租两居，5000-8000:

```bash
opencli ke zufang --city bj --district 'zaojunmiao/rt200600000001l1rp5rp6' --limit 30 -f json
```

大钟寺/皂君庙附近整租两居，6000-8000:

```bash
opencli ke zufang --city bj --district 'zaojunmiao/rt200600000001l1rp6' --limit 30 -f json
```

大钟寺/皂君庙附近整租两居，8000+:

```bash
opencli ke zufang --city bj --district 'zaojunmiao/rt200600000001l1rp7' --limit 30 -f json
```

Adjacent area sweep:

```bash
opencli ke zufang --city bj --district 'zaojunmiao/rt200600000001l1rp5rp6' --limit 30 -f json
opencli ke zufang --city bj --district 'zhichunlu/rt200600000001l1rp5rp6' --limit 30 -f json
opencli ke zufang --city bj --district 'shuangyushu/rt200600000001l1rp5rp6' --limit 30 -f json
opencli ke zufang --city bj --district 'beitaipingzhuang/rt200600000001l1rp5rp6' --limit 30 -f json
```

## Result Cleaning

After collecting JSON:

1. Deduplicate by `url`.
2. Keep only titles beginning with `整租·`.
3. Keep only layouts matching `2室` or explicit two-bedroom intent.
4. Parse `price` as integer and enforce the user's budget locally.
5. Reject obvious fallback/recommendation rows outside the target area if the requested area is narrow.
6. Sort by user preference: usually lowest price first, then closest/known nearby community, then area size.

For 大钟寺 searches, prefer communities containing or near:

- 大钟寺
- 皂君
- 双榆树
- 知春
- 农科院
- 鑫雅苑
- 文林
- 青云
- 太月园
- 罗庄
- 蓟门

If a listing looks suspiciously far away, report it as uncertain rather than silently including it.

## Reporting Format

When reporting concrete listings, include query date and command pattern. Use a compact table:

| 小区 | 户型 | 面积 | 月租 | 备注 | 链接 |
|---|---:|---:|---:|---|---|

Keep notes pragmatic:

- `贴近大钟寺`
- `价格边界`
- `可能偏远，需地图确认`
- `面积偏小`

Do not overstate freshness. Listings can disappear quickly.

## Route and Commute Extension

For route/commute ranking, use a map API instead of Beike:

- Best target: 高德 Web 服务 API or official AMap MCP Server.
- Required key: `AMAP_MAPS_API_KEY`.
- Useful capabilities: geocode community/address, POI search, transit/walking/cycling/driving route, distance.
- Current local `amap-collect` skill only handles 高德网页收藏, not general route calculation.

Suggested pipeline:

1. Query listings with Beike/opencli.
2. Geocode `community + 北京` through AMap.
3. Geocode destination(s), such as company, gym, frequent places.
4. Calculate transit/walking/cycling commute.
5. Rank by budget, commute, and area.

If no AMap key is configured, state that route ranking is blocked and provide only listing links plus area notes.

## Safety and Compliance

This workflow is low-frequency personal assistance. Do not build high-volume scraping, bypass login walls, or run aggressive pagination. If Beike returns login/captcha/empty pages, stop and report the blocker.

Never expose local files or workspace data through public servers while doing rental work.
