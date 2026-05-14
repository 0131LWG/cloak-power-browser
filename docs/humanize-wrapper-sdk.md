# Wrapper-style Humanize SDK

`cloak-power-browser` 默认推荐使用 wrapper-style 行为层：不抢系统鼠标，不抢键盘焦点，适合多窗口并发自动化。

Native Humanize API 仍然保留，但只建议用于单窗口、高拟真、低并发任务。

## 安装方式

当前 SDK 放在项目内：

```text
packages/sdk
```

其它自动化项目可以先用本地路径引用：

```js
import {
  openCloakProfile,
  patchPuppeteerPage,
  humanClick,
  humanType,
  humanWheel,
} from '/Users/guan/Documents/crypto/cloak-power-browser/packages/sdk/index.mjs';
```

后续可以把它单独发布成 npm 包，例如 `@cloak-power/sdk`。

## Puppeteer 用法

```js
import puppeteer from 'puppeteer';
import {openCloakProfile} from '/Users/guan/Documents/crypto/cloak-power-browser/packages/sdk/index.mjs';

const {page, close} = await openCloakProfile({
  server: 'http://127.0.0.1:49156',
  windowId: 1,
  driver: 'puppeteer',
  puppeteer,
  humanize: true,
  humanizeOptions: {
    moveSteps: [18, 36],
    keyDelay: [70, 220],
    actionDelay: [300, 1200],
  },
});

await page.goto('https://example.com', {waitUntil: 'networkidle2'});

// 这些 API 已经被 patch 成拟人化行为
await page.click('#login');
await page.type('#email', 'hello@example.com');
await page.mouse.wheel({deltaY: 700});

await close();
```

## Playwright 用法

```js
import {chromium} from 'playwright';
import {openCloakProfile} from '/Users/guan/Documents/crypto/cloak-power-browser/packages/sdk/index.mjs';

const {page, close} = await openCloakProfile({
  server: 'http://127.0.0.1:49156',
  windowId: 1,
  driver: 'playwright',
  playwright: {chromium},
  humanize: true,
});

await page.goto('https://example.com', {waitUntil: 'networkidle'});
await page.click('#login');
await page.type('#email', 'hello@example.com');
await page.mouse.wheel(0, 700);

await close();
```

## 显式 Human API

如果不想 patch 原始 API，也可以显式调用：

```js
import {
  openCloakProfile,
  humanClick,
  humanType,
  humanWheel,
} from '/Users/guan/Documents/crypto/cloak-power-browser/packages/sdk/index.mjs';

const {page} = await openCloakProfile({
  windowId: 1,
  puppeteer,
  humanize: false,
});

await humanClick(page, '#login');
await humanType(page, '#email', 'hello@example.com');
await humanWheel(page, {deltaY: 700});
```

## 与 Native Humanize 的区别

```text
Wrapper-style SDK:
  patch Puppeteer / Playwright API
  不移动真实系统鼠标
  不抢焦点
  适合多窗口并发

Native Humanize API:
  调用系统鼠标、键盘、滚轮
  会移动真实鼠标
  会抢焦点
  只适合单窗口高拟真任务
```

## 当前已 patch 的能力

Puppeteer：

```text
page.click(selector)
page.type(selector, text)
page.mouse.wheel({ deltaY })
```

Playwright：

```text
page.click(selector)
page.type(selector, text)
page.fill(selector, text)
page.mouse.wheel(deltaX, deltaY)
page.locator(selector).click()
page.locator(selector).type(text)
page.locator(selector).fill(text)
```

行为层会加入：

```text
鼠标 Bezier 轨迹
随机点击点
点击前后停顿
逐字符输入
滚动分段和节奏变化
动作之间阅读/思考延迟
```
