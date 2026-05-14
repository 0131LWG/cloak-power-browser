# CloakBrowser 集成说明

这个项目是基于 `chrome-power-app` 的二次开发，目标是把它改造成一个桌面端指纹浏览器外壳。

## 项目目标

复用 `chrome-power-app` 已有的 Electron 桌面端、窗口管理、代理管理、批量导入、API 服务等能力，把底层浏览器运行时逐步替换成 CloakBrowser。

可以这样理解：

```text
chrome-power-app = 桌面端管理外壳
CloakBrowser = 抗检测浏览器内核
本项目 = 自己的指纹浏览器桌面端
```

## 第一阶段目标

第一阶段先不追求完整产品化，只跑通一个最小闭环：

- 在现有桌面端里创建 profile。
- 给 profile 绑定代理。
- 使用独立的 `user-data-dir` 启动 CloakBrowser。
- 为每个浏览器实例暴露独立的远程调试端口。
- 让 cookie、localStorage、session 数据按 profile 持久化。
- 关闭 profile 后，下次重新打开还能恢复登录状态。

这个闭环跑通后，再做批量导入、批量启动、指纹参数 UI、任务队列会更稳。

## 当前已经完成

当前已经完成第一版底层接入：

- 新增 CloakBrowser 启动适配器：`packages/main/src/cloakbrowser/launcher.ts`
- 新增地理一致性策略：`packages/main/src/cloakbrowser/geo-consistency.ts`
- 新增官方 runtime 清单：`cloakbrowser.runtime.json`
- 新增运行时下载管理器：`packages/main/src/cloakbrowser/runtime-manager.ts`
- 改造原窗口启动入口：`packages/main/src/fingerprint/index.ts`
- 扩展设置类型：`packages/shared/types/common.d.ts`
- 支持在新建窗口时选择浏览器内核和 CloakBrowser 版本。
- CloakBrowser runtime 采用首次使用时下载，不需要提前打包进应用。

## 运行配置

开发阶段可以先通过环境变量配置 CloakBrowser，后面再做进设置页面。

需要配置：

```bash
export CLOAK_BROWSER_ENABLED=1
export CLOAK_BROWSER_PATH=/absolute/path/to/cloakbrowser
npm run watch:mac
```

字段含义：

- `CLOAK_BROWSER_ENABLED=1`：启用 CloakBrowser 启动模式。
- `CLOAK_BROWSER_PATH`：CloakBrowser 可执行文件的绝对路径。

正式打包后不需要配置 `CLOAK_BROWSER_PATH`。如果窗口选择的是 CloakBrowser，应用会在打开窗口前检查本地 runtime；没有下载过就从 CloakBrowser GitHub Releases 下载。

启动路径优先级：

```text
1. 窗口选择 CloakBrowser：使用 Runtime Manager 下载/缓存的 CloakBrowser
2. CLOAK_BROWSER_PATH
3. 设置页里的 cloakBrowserPath
4. 原 chrome-power-app 的 chromiumBinPath / 本机 Chrome
```

## 地理一致性策略

启动 CloakBrowser 时，项目会根据代理识别出的国家和时区自动补齐浏览器语言环境。

例如日本代理会默认使用：

```text
country = JP
timezone = Asia/Tokyo
locale = ja-JP
Accept-Language = ja-JP,ja,en-US,en
```

目前内置的常用映射包括：

```text
JP -> Asia/Tokyo + ja-JP
US -> America/New_York + en-US
CA -> America/Toronto + en-CA
GB -> Europe/London + en-GB
DE -> Europe/Berlin + de-DE
FR -> Europe/Paris + fr-FR
SG -> Asia/Singapore + en-SG
HK -> Asia/Hong_Kong + zh-HK
TW -> Asia/Taipei + zh-TW
CN -> Asia/Shanghai + zh-CN
KR -> Asia/Seoul + ko-KR
AU -> Australia/Sydney + en-AU
```

如果后续 profile 里手动设置了 `timezone` 或 `locale`，手动设置优先。

启动参数会统一成 CloakBrowser 官方指纹参数：

```text
--fingerprint=固定 seed
--fingerprint-platform=macos
--fingerprint-timezone=Asia/Tokyo
--fingerprint-locale=ja-JP
--lang=ja-JP
--accept-lang=ja-JP,ja,en-US,en
--fingerprint-webrtc-ip=auto
```

## CloakBrowser Runtime Manager

目标是应用本体保持轻量，不要求本机额外安装 Chromium 或 CloakBrowser，也不把 CloakBrowser 大二进制预置进安装包。

项目使用 `cloakbrowser.runtime.json` 记录每个平台可用的官方 release、asset、sha256 和可执行文件相对路径。这样 CloakBrowser 官方 release 某次只更新 Windows 或只更新 Linux 时，我们可以只更新对应平台，不会错误地把 macOS 也指向不存在的新包。

当前清单状态：

```text
darwin-arm64 -> chromium-v145.0.7632.109.2 -> cloakbrowser-darwin-arm64.tar.gz
darwin-x64   -> chromium-v145.0.7632.109.2 -> cloakbrowser-darwin-x64.tar.gz
win32-x64    -> chromium-v146.0.7680.177.4 -> cloakbrowser-windows-x64.zip
```

新建窗口时可以选择：

```text
Kernel:
  原 Chromium
  本机 Chrome
  CloakBrowser

CloakBrowser Version:
  当前平台可用版本列表
  推荐 / 已下载 / 未下载状态
```

打开窗口时流程：

```text
1. 读取窗口 browser_engine
2. 如果不是 CloakBrowser，继续走原 chrome-power-app 启动逻辑
3. 如果是 CloakBrowser，读取 browser_version
4. 检查本地 userData/runtimes/cloakbrowser/<platform>/<version>
5. 本地已有：直接启动
6. 本地没有：从 GitHub Releases 下载对应 asset
7. 校验 sha256
8. 解压并缓存
9. 启动 CloakBrowser
```

本地 runtime 缓存目录：

```text
macOS:
~/Library/Application Support/<AppName>/runtimes/cloakbrowser/darwin-arm64/<tag>

Windows:
%APPDATA%/<AppName>/runtimes/cloakbrowser/win32-x64/<tag>
```

`npm run cloak:prepare` 仍保留为开发辅助脚本，用于提前把官方压缩包校验并解压到本地调试目录；正式产品流程不依赖这个脚本。

## 更新 CloakBrowser runtime

更新时不要只看最新 tag，要看 release 里对应平台有没有新的 asset。

推荐流程：

1. 打开 CloakBrowser Releases。
2. 找到目标平台对应的 asset，例如 `cloakbrowser-darwin-arm64.tar.gz` 或 `cloakbrowser-windows-x64.zip`。
3. 如果某个平台没有出新 asset，就保留旧版本。
4. 更新 `cloakbrowser.runtime.json` 里该平台的 `tag`、`asset`、`sha256` 和必要的 `notes`。
5. 重新打包应用；用户打开对应 profile 时会按新的清单自动下载。

验证重点：

```text
chrome://version
  可执行文件路径：应指向本机 userData/runtimes/cloakbrowser/<platform>/<tag>
  命令行：应包含 --fingerprint / --fingerprint-platform / --fingerprint-timezone / --fingerprint-locale
```

## 当前架构

```text
Electron 前端页面
  -> 创建/打开 profile
  -> IPC 调用 window-open
  -> Electron 主进程
  -> CloakBrowser launcher 适配层
  -> 启动 CloakBrowser 进程
  -> 返回 CDP 调试地址
```

## 下一步开发顺序

建议按这个顺序推进：

1. 安装或准备 CloakBrowser 可执行文件。
2. 配置 `CLOAK_BROWSER_PATH`。
3. 启动桌面端，创建一个 profile。
4. 点击打开 profile，确认 CloakBrowser 可以正常启动。
5. 登录一个测试网站，关闭窗口，再重新打开确认登录态保留。
6. 加入设置页面，让用户可以在 UI 里配置 CloakBrowser 路径。
7. 扩展 profile 指纹字段，例如语言、时区、UA、平台、屏幕尺寸、WebRTC 策略。
8. 扩展批量导入模板，支持批量导入 profile、代理、cookie。
9. 增加批量启动并发限制，避免一次打开太多浏览器导致内存爆掉。

## 后续要做的关键模块

### 1. 设置页面

把下面这些配置做成 UI：

- 是否启用 CloakBrowser。
- CloakBrowser 可执行文件路径。
- 默认 profile 缓存目录。
- 默认并发启动数量。

### 2. Profile 指纹字段

给每个 profile 增加更多指纹配置：

- fingerprint seed
- locale
- timezone
- user agent
- platform
- screen width
- screen height
- WebRTC 策略

### 3. 批量导入

扩展 Excel/CSV 导入字段：

- profile 名称
- 分组
- 备注
- 代理
- cookie
- locale
- timezone
- user agent
- fingerprint seed

### 4. 批量启动

增加任务队列和并发限制：

```text
待启动 profile 列表
  -> 每次最多启动 N 个
  -> 启动成功后记录 PID、端口、CDP 地址
  -> 启动失败写入日志
```

### 5. 自动化接口

每个 profile 启动后，需要能看到：

- PID
- 调试端口
- CDP URL
- WebSocket Debugger URL
- 当前运行状态

这样后续 Playwright/Puppeteer 或 AI Agent 才能连接并控制对应浏览器。

## 注意事项

- CloakBrowser 是底层浏览器能力，不是完整的 AdsPower/GoLogin 替代品。
- 本项目要补齐的是外壳能力：管理、导入、批量、多开、调度、日志、UI。
- 多开时一定要限制并发，单个浏览器实例可能占用几百 MB 内存。
- 商业化前需要认真确认 `chrome-power-app` 的 AGPL-3.0 许可，以及 CloakBrowser binary 的使用许可。
