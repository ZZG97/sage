---
name: amap-collect
description: 在高德地图网页版批量收藏地点（餐厅、景点等）。当用户说"帮我在高德地图收藏XXX"、"把这些地方加到高德收藏"、"amap 收藏"、"高德收藏一下"时触发。输入：地点名列表 + 可选城市/地区。
---

# 高德地图批量收藏

## 前提

需要 Playwright 浏览器工具（`mcp__playwright__*`）。用户需已在高德地图登录账号——如未登录，收藏操作会失败或跳转登录页，此时告知用户先扫码/登录。

## 流程（每个地点执行一次）

### 第一步：搜索

```
navigate → https://www.amap.com
在搜索框输入："地点名 城市/地区"（如"半步多包子铺 雄安"）
按 Enter 搜索
```

### 第二步：进入详情页

```
browser_snapshot 获取页面结构
找到搜索结果列表的第一个 listitem，点击它
→ 页面会跳转到 https://www.amap.com/place/{POI_ID}
```

> **不要**在搜索结果页直接找收藏按钮——结果页没有该按钮，必须先进详情页。

### 第三步：找收藏按钮并点击

```
browser_snapshot 获取详情页结构
在 snapshot 中找 "收藏" 文字对应的 ref（格式如 generic [ref=eXXX] [cursor=pointer]: 收藏）
用 browser_click 点击该 ref
```

> **关键**：必须用 snapshot 的 ref 点击，不要用 JS `evaluate` + `parentElement.click()`。
> 原因：高德的 `parentElement.click()` 会触发 faves panel 切换逻辑（把详情面板关掉），而非真正执行收藏。
> ref 每次页面加载都不同，不能硬编码，必须每次 snapshot 后重新获取。

### 第四步：验证

```
browser_take_screenshot 截图确认
```

成功标志：左侧详情面板中星星图标变为金色，文字从"收藏"变为"已收藏"。

如果页面跳走或面板消失，说明点错了位置——`navigate` 回 `https://www.amap.com/place/{POI_ID}` 重试。

## 批量处理

逐个处理，每个地点完成（确认"已收藏"）后再处理下一个。处理完毕后，汇总报告：哪些成功，哪些失败及原因。

## 常见问题

| 现象 | 原因 | 处理 |
|------|------|------|
| 点击后详情面板消失 | 用了 JS click 而非 ref click | navigate 回详情页，重新 snapshot + ref click |
| 搜索结果为空 | 地点名有误或地区太宽泛 | 换更精确的搜索词，或告知用户确认地点名 |
| 跳转登录页 | 未登录 | 告知用户在浏览器中登录高德账号后重试 |
| 多个结果不确定选哪个 | 同名地点多 | 截图给用户确认，或选评分最高/距离最近的 |
