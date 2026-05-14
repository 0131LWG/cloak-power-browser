# Native Humanize 设计

当前实现是一版系统级真人行为层。它会真实移动系统鼠标、键盘、滚轮，所以只建议用于单窗口、高拟真、低并发任务。

多窗口并发自动化默认应使用 `packages/sdk` 里的 wrapper-style humanize，详见：

```text
docs/humanize-wrapper-sdk.md
```

## 设计原则

Native 模式优先级如下：

```text
1. Native input：系统级鼠标、键盘、滚轮事件
2. CDP/Puppeteer：只用于元素定位或复杂字符输入兜底
3. DOM evaluate：避免用于关键交互
```

## 已实现接口

接口挂在本地 API 服务下：

```text
POST /humanize/click
POST /humanize/type
POST /humanize/scroll
```

### 点击 selector

```bash
curl -X POST http://localhost:<serverPort>/humanize/click \
  -H "Content-Type: application/json" \
  -d '{"windowId": 1, "selector": "button[type=submit]"}'
```

流程：

```text
Puppeteer 读取元素位置
-> 换算成屏幕坐标
-> native addon 移动鼠标
-> native addon mouse down/up
```

### 点击坐标

```bash
curl -X POST http://localhost:<serverPort>/humanize/click \
  -H "Content-Type: application/json" \
  -d '{"windowId": 1, "x": 600, "y": 420}'
```

### 输入文本

```bash
curl -X POST http://localhost:<serverPort>/humanize/type \
  -H "Content-Type: application/json" \
  -d '{"windowId": 1, "selector": "input[name=email]", "text": "hello@example.com"}'
```

ASCII 字符会优先使用 native key event。中文、emoji、复杂输入会降级到 Puppeteer keyboard 输入。

### 滚动

```bash
curl -X POST http://localhost:<serverPort>/humanize/scroll \
  -H "Content-Type: application/json" \
  -d '{"windowId": 1, "deltaY": 900}'
```

## 当前限制

- selector 定位仍依赖 Puppeteer 读取元素位置。
- macOS native 输入需要辅助功能权限。
- 非 ASCII 输入会 fallback 到 Puppeteer。
- 还没有接任务队列、UI 按钮、日志回放。
- 鼠标初始点目前是按窗口范围生成，不读取真实当前指针位置。

## 后续优化

- 增加 Playwright adapter。
- 增加 profile 固定行为风格，例如快/慢鼠标、输入节奏、滚动风格。
- 支持“观察等待”：页面加载后模拟阅读停顿。
- 增加任务执行 DSL。
- UI 上展示每个 profile 的 humanize 模式。
