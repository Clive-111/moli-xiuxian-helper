# 茉莉修仙传助手

通过 Discord 网页管理「霜月茉莉」中的「茉莉修仙传」，提供本地控制面板。支持 Docker 和 Windows，登录及首次授权由使用者手动完成。

## 功能

- 选择已解锁战斗地图及安全调息地点；气血严格大于 95% 才进入战斗，支持再探、秒杀回城及界面恢复。
- 灵髓按本人明确勾选的种类，每 10 分钟使用全部现有库存；默认关闭、无勾选。
- 行囊、炼制、卖出、换装、图鉴，以及材料链、灵髓、炼材、地图掉落期望。
- 单一操作队列、持久化操作记录和结果核对；不自动重复提交不确定的消费操作。
- 开关挂机与关闭游戏分别控制；保存的停止意图及关闭游戏状态跨重启保留。

仅支持这款游戏及其当前中文界面，不包含墨铃的两小时游历任务。地图、商店和物品来自游戏公开资源，并用当前人物的页面核实可用性；目录不代表该人物已解锁。

## 安装前：选择一种运行方式

在 Windows 上直接运行，可选「Windows 原生」；需要容器部署时选「Docker」。两种方式任选一种，每个游戏账号同时只运行一个实例。

| 准备项 | Windows 原生 | Docker |
| --- | --- | --- |
| Node.js | 本机安装，最低 22，推荐 **24 LTS** | 容器内提供，本机无需为本项目安装 |
| npm | 随 Node.js 标准安装包安装 | 容器内提供 |
| 游戏操作浏览器 | 默认使用本机 Chrome，也可配置 Edge 或 Chromium | 容器内提供 Chromium，通过 7080 浏览器画面登录 |
| 项目依赖 | 双击 `install.cmd` 自动安装 | 构建镜像时自动安装 |
| Docker | 无需安装 | Windows 安装并启动 Docker Desktop；Linux 使用 Docker Engine 和 Compose v2 |
| Git | 可选；下载源码 ZIP 不需要 Git | 可选；下载源码 ZIP 不需要 Git |

**项目依赖是什么？** [package.json](package.json) 列出本项目使用的 JavaScript 库：Playwright 负责操作游戏浏览器，Acorn 负责解析公开游戏资源中的地图和物品定义。`install.cmd` 会执行 `npm ci`，按 [package-lock.json](package-lock.json) 锁定的版本安装到项目的 `node_modules/`，无需分别手动安装这些库。`install.cmd` 不会代替你安装 Node.js 或 Chrome；使用默认 Chrome 模式时，也不需要额外下载 Playwright 的 Chromium。

安装依赖和构建镜像需要联网；使用时需能访问 Discord 和游戏。Node.js 的 Windows 安装程序及 LTS 说明见 [Node.js 下载页](https://nodejs.org/en/download)和 [npm 安装说明](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm/)。

## 快速开始：Docker

Windows 首次安装：

1. 按 [Docker Desktop 官方 Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/)安装，按安装器和官方系统要求完成 WSL 2、虚拟化等准备。
2. 启动 Docker Desktop，等待引擎启动完成，使用 **Linux 容器**模式。在终端执行 `docker version` 应能看到客户端和服务端信息，`docker compose version` 应能返回 Compose v2 版本。
3. 从 [GitHub 仓库](https://github.com/Clive-111/moli-xiuxian-helper)点击 **Code → Download ZIP**，完整解压到可写目录，例如 `D:\moli-xiuxian-helper`。进入包含 `compose.yaml` 的项目根目录，双击 `docker-setup.cmd`。
4. 等待镜像构建和服务启动完成。首次需要下载镜像、系统组件和项目依赖，耗时取决于网络；失败时查看窗口中的具体错误。

容器已经包含 Node.js、npm、Chromium 和需要的系统组件，本机不必再运行 `install.cmd`。Linux 用户准备好 Docker Engine 和 Compose v2 后，在源码根目录执行 `docker compose up -d --build`。

如果已安装 Git，也可以在终端使用以下方式下载并启动：

```sh
git clone https://github.com/Clive-111/moli-xiuxian-helper.git
cd moli-xiuxian-helper
docker compose up -d --build
```

默认入口分工如下；修改端口后以自己的配置为准：

| 地址 | 用途 |
| --- | --- |
| <http://localhost:7081> | 控制面板：绑定人物、选择地点、管理挂机与物品 |
| <http://localhost:7080/vnc.html> | 容器里的浏览器画面：手动登录 Discord、处理授权和游戏提示 |

启动后首次设置：

1. 打开控制面板：<http://localhost:7081>。
2. 点击「1. 打开游戏 / 登录」。从面板左侧进入浏览器画面，默认 <http://localhost:7080/vnc.html>，手动登录 Discord、完成 App 授权并进入已创建的人物。
3. 在游戏中显示角色头像页，回到面板点击「2. 读取人物」。确认显示的是自己的**完整人物名**，再点击「3. 确认绑定此人物」。
4. 确认绑定后会自动读取战斗与调息地点、背包、炼制配方和图鉴。等待面板显示「已全部读取」，再选择已经核实可用的战斗地点；可选调息点，留空为就地调息。保存并应用。
5. 点击「启动挂机」。首次绑定、刷新资料和保存配置本身不会启动挂机。

登录时出现暂停或读取超时，可以处理游戏画面后再次点击读取。脚本不会选择存档、创建人物或处理验证码。默认频道已填写，使用者需要自己拥有该频道和游戏的访问权限。

首次打开使用 Discord 的网页版登录入口，避免频道链接唤起已安装的桌面客户端。请在脚本的独立浏览器中登录；桌面客户端的登录状态不能代替此窗口的网页版登录。登录后点击「读取人物」再进入配置的频道。若遇到“Discord APP 已开启”，再次点击「打开游戏 / 登录」会返回网页版入口。

确认绑定及每次「打开游戏」后，会通过同一队列自动读取地点、背包、配方和图鉴；面板显示当前进度，单项失败保留旧数据并说明原因，可点击「刷新全部资料」重试。读取会浏览游戏里的资料页面，完成后返回游历，不会选择挂机目标、开始炼制或使用物品。遇到人物不符、未确认弹窗或待核对操作时暂停，停止或关闭游戏会取消剩余读取。

已有绑定的实例启动时也会自动核对上述资料，并准备卖出地点；之前明确关闭游戏或存在待核对物品操作时不会自动打开、重放操作。

当前位置和气血在绑定后立即读取，保持连接且停止挂机时每 5 秒只读刷新，也可以点击「读取状态」。支持同一独立浏览器里的 Discord 游戏弹出窗口；出现多个游戏画面时暂停并显示原因。「刷新地点目录」仍可单独更新地图。

## 快速开始：Windows 原生

### 1. 下载并解压源码

打开 [GitHub 仓库](https://github.com/Clive-111/moli-xiuxian-helper)，点击 **Code → Download ZIP**。完整解压到可写目录，推荐 `D:\moli-xiuxian-helper`；下面命令均使用这个示例路径，请按实际路径调整。进入能看到 `package.json`、`install.cmd` 和 `start.cmd` 的目录，不要直接在 ZIP 压缩包内运行脚本。

### 2. 安装 Node.js 与浏览器

从 [Node.js 官网](https://nodejs.org/en/download)下载 Windows 安装包，推荐 **Node.js 24 LTS**，本项目最低要求为 22。按默认选项安装，保留 npm 和加入 PATH 的选项；npm 是安装项目依赖用的工具，标准安装包已包含它。

安装完成后，重新打开「命令提示符（CMD）」，分别执行：

```bat
node -v
npm -v
```

两条命令都应显示版本号；Node.js 24 的输出以 `v24.` 开头。若提示找不到命令，先关闭并重新打开终端；仍失败时检查 Node.js 安装和 PATH，具体见下方常见问题。

默认还需要安装 [Google Chrome](https://www.google.com/chrome/)。脚本会使用独立浏览器资料目录，登录需在它打开的窗口里完成。已有 Edge 的用户可使用本节末尾的替代配置。

### 3. 安装项目依赖并启动

1. 在项目目录双击 `install.cmd`。它会检查 Node.js 是否可用、执行 `npm ci` 安装依赖，并将 npm 缓存和安装临时文件放在项目的 `work/` 下。看到 `Installed` 表示安装成功；失败时先处理窗口里的错误。
2. 双击 `start.cmd`。看到控制面板地址后，打开 <http://localhost:7081>；端口改过时使用终端实际打印的地址。
3. 点击「打开游戏 / 登录」，切换到脚本打开的独立浏览器，手动登录 Discord 并完成授权。回到面板读取人物、确认绑定，等待资料同步，再选择战斗及调息地点，保存并启动挂机。存档选择或验证码需手动处理。

第一次使用需要安装依赖；以后一般直接运行 `start.cmd`。更新源码、依赖文件变化后，先停止自己的实例，再重新运行 `install.cmd`。

熟悉命令行的用户，也可以在 **CMD** 中执行以下等价安装、启动命令（请替换成自己的项目路径）：

```bat
cd /d "D:\moli-xiuxian-helper"
set "npm_config_cache=%CD%\work\npm-cache"
set "TEMP=%CD%\work\tmp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
npm ci
npm start
```

请确认 `npm ci` 成功后再执行 `npm start`。使用 PowerShell 时可直接运行 `.\install.cmd`、`.\start.cmd`；手动调用 npm 可用 `npm.cmd ci`、`npm.cmd start`，避免 `npm.ps1` 被执行策略阻止。

原生模式直接在独立浏览器窗口中登录，不提供 7080/noVNC 入口。运行期间保留启动终端，电脑保持运行。关闭独立浏览器窗口会停止自动操作并保留控制面板，可从面板重新打开游戏；登录资料和已有记录继续保留。按启动终端的 Ctrl+C 结束脚本。

### 可选：使用 Edge 或 Chromium

没有 `config.json` 时，先复制 `config.example.json` 为 `config.json`；已有该文件则直接编辑，保留自己的配置。仅修改其中的 `browserChannel`，例如使用 Edge 时设为 `"browserChannel": "msedge"`。已经运行时，配置在下次启动自己的实例后生效。

| 浏览器 | `browserChannel` 值 | 准备方式 |
| --- | --- | --- |
| Google Chrome（默认） | `chrome` | 本机安装 Chrome |
| Microsoft Edge | `msedge` | 本机已安装 Edge |
| Playwright Chromium | `chromium` | 安装项目依赖后下载匹配的 Chromium，见下方命令 |

选择 Chromium 时，在 **CMD** 的项目根目录运行下面命令，将浏览器下载到 D 盘项目目录。这里的 `npx` 同样随 npm 提供：

```bat
cd /d "D:\moli-xiuxian-helper"
set "npm_config_cache=%CD%\work\npm-cache"
set "TEMP=%CD%\work\tmp"
set "TMP=%TEMP%"
if not exist "%TEMP%" mkdir "%TEMP%"
set "PLAYWRIGHT_BROWSERS_PATH=D:/moli-xiuxian-helper/work/pw-browsers"
npx playwright install chromium
```

同时在项目根目录的 `.env` 中加入下面一行，让以后的启动也使用同一个浏览器目录；没有 `.env` 时可先复制 `.env.example`。如果使用了其他解压路径，安装命令和 `.env` 中的路径都要对应修改：

```dotenv
PLAYWRIGHT_BROWSERS_PATH=D:/moli-xiuxian-helper/work/pw-browsers
```

更新项目依赖后，如果使用 Chromium，需要重新运行下载命令以匹配 Playwright 版本。浏览器安装和缓存位置详见 [Playwright 官方浏览器说明](https://playwright.dev/docs/browsers)。

## 安装与启动常见问题

| 现象 | 处理方式 |
| --- | --- |
| `node` 或 `npm` 不是内部或外部命令 | 安装推荐的 Node.js LTS，保留 npm/PATH 选项，再重新打开终端检查版本；可用 `where node`、`where npm` 查看命令位置。 |
| Node.js 版本低于 22 | 升级到推荐的 24 LTS 后重新打开终端，再运行 `install.cmd`；脚本只检查命令存在，版本需自行核对。 |
| PowerShell 提示不能运行 `npm.ps1` | 双击 `install.cmd`、`start.cmd`，或使用 `npm.cmd` 命令；不需要为本项目放宽全局执行策略。 |
| 提示先运行 `install.cmd`，或找不到 Playwright 等模块 | 在包含 `package.json` 和 `package-lock.json` 的完整源码目录重新运行 `install.cmd`，安装成功后再启动。 |
| `npm ci` 下载超时、网络或证书错误 | 查看安装窗口的首个错误，检查 npm 包下载网络及自己使用的代理；恢复后重试 `install.cmd`。游戏的 `BROWSER_PROXY_SERVER` 仅控制游戏网络，不代替 npm 的网络配置。 |
| 提示 Chrome 可执行文件不存在 | 安装 Chrome，或按上面的说明将 `browserChannel` 改为已安装的 Edge；选择 Chromium 时需完成下载并配置同一浏览器目录。 |
| Docker 命令找不到或无法连接 Docker 服务 | 安装并启动 Docker Desktop，等待引擎就绪、确认使用 Linux 容器，再检查 `docker version`、`docker compose version`。 |
| Docker 镜像构建失败 | 查看构建窗口中的错误，检查镜像仓库和软件包下载网络；引擎、网络恢复后重新运行 `docker-setup.cmd`。 |
| 面板端口被占用 / `EADDRINUSE` | 在 `.env` 中为自己的实例设置其他 `CONTROL_PORT`，例如 `17081`，重新启动后打开终端打印的新地址；Docker 的浏览器画面端口也可用 `VNC_PORT` 调整。 |
| 浏览器提示 localhost 拒绝连接 | 先确认启动终端仍在运行，或 Docker 容器启动成功，并核对实际面板端口；原生模式打开 7081，Docker 的 7080 用于浏览器画面。 |

## 配置与网络

无个人配置文件也能启动。`config.example.json` 是干净的运行默认值，人物及目标保存在面板数据中，不要把旧的个人配置整体导入。

复制 `.env.example` 为 `.env` 可调整端口和代理：

```dotenv
CONTROL_PORT=7081
VNC_PORT=7080
BROWSER_PROXY_SERVER=
```

- 默认直连，不会探测或自动选择代理。需要代理时填写本人使用的地址；Docker 访问宿主机代理可以使用 `http://host.docker.internal:你的端口`，Windows 原生使用本机代理地址。Linux Docker 需要按自己的网络环境提供可达地址。
- `.env` 或进程环境变量优先于运行配置，已有进程环境变量优先于 `.env`。`VNC_PORT` 只影响 Docker 浏览器画面的宿主机端口。
- 端口只绑定 `127.0.0.1`。端口被占用时修改配置后重启自己的实例；启动脚本不会结束占用端口的其他进程。原生与 Docker 使用相同的面板端口时也会冲突。
- 原生的浏览器资料和数据默认相对项目根目录解析，与启动时的工作目录无关。也支持 `node src/main.js --config 路径`。
- Docker 默认使用公开配置。若需修改浏览器以外的运行参数，可用自己的 `compose.override.yaml` 将 `config.json` 只读挂载到 `/app/config.json`。容器浏览器固定使用 Chromium 和独立持久卷。

## 人物与数据

每份数据目录只绑定一个人物。人物名从可见角色区完整读取，确认绑定时再次读取；五分钟后确认过期。日常操作前继续核对名字，发现不符会暂停。本工具根据页面姓名校验，不承诺区分显示名完全相同的不同账号。

| 位置 | 内容 |
| --- | --- |
| `data/control/identity.json` | 本实例的人物、频道及游戏绑定 |
| `data/control/profiles/<编号>/owner.json` | 缓存与历史的归属校验 |
| 同编号目录 | 设置、库存、目录、图鉴、炼制与物品操作记录、物品图片 |
| `.browser-profile/` | Windows 独立登录资料及灵髓计时 |
| Docker 项目的 `browser-profile` 卷 | 容器独立登录资料及灵髓计时 |
| `logs/` | 本地日志与普通失败诊断，可能包含人物信息 |

不要通过删除记录、编辑绑定或清空卷来解决待确认操作。换号或改名第一版使用独立运行目录，不自动继承库存、历史或计时；不能让两个实例同时操作同一账号。丢失绑定文件但发现旧数据时会拒绝自动认领。

面板的「关闭游戏」保留登录、设置和待核对记录，重启也不自动重连；明确「打开游戏」后仍保持停止。关闭游戏页面不代表服务端活动停止。「撤退并停止」才尝试确认退出战斗。

## 物品与异常处理

- 卖出地点会在启动、绑定和打开游戏后的资料同步中自动准备：保留已有设置；未设置时优先使用当前位置唯一且入口可用的商店，否则从本次地图核实可见、没有额外开放条件的安全地点中选择。同区域优先，不包含个人预设商店；找不到可靠候选时保留为空。准备地点不移动人物、不卖出物品，执行前仍需核对实际商店入口。
- 行囊顶部手动切换「卖出商店」后自动保存，不需要再点保存按钮。保存失败会说明原因并允许重试，批量选择和数量保留；修改默认地点不会自动改动或继续正在处理的卖出批次。已装备物品不会被自动卸下售卖。
- 批量卖出优先使用游戏新增的勾选出售：按具体编号选择器物和炼材，核对名单、品质及价格后统一提交，每组最多 1000 件；无需逐件打开详情。叠加物品仍按本次确认的数量处理。没有批量入口的旧界面继续使用逐件流程；入口显示不完整时暂停。
- 批量售出会先保存整组待核对记录，再提交一次；超时、部分售出或重启后只核对结果，不自动重卖。已确认的编号不会再次加入后续组。
- 炼制支持指定数量，合炼/升炼需要本人选择具体实例。结算未完全证实时显示核对状态，不冒充成功、不重复开炉。
- 卖出与换装的未确认记录继续阻止重复动作；使用面板「仅核对」后，再决定继续或取消剩余。
- 所有物品操作通过真实游戏页面进行，不上传云存档。角色、登录、存档冲突和未知确认弹窗由本人处理。
- 目录刷新失败保留旧目录；锁定或不确定地图不进入。掉落推荐是理论期望，不保证随机掉落拿齐，也不会自动替换挂机目标。
- 需要排查容器时使用 `docker compose logs --tail 100 battle`、`docker compose ps`。更新本项目使用 `docker compose up -d --build`，会重启该项目的实例；不要删除卷。

## 开发与验证

```sh
npm ci
npm test
```

测试使用本地模拟页面和独立浏览器，不登录 Discord。Windows 默认使用 Chrome；可通过 `TEST_BROWSER_CHANNEL=msedge` 切换。容器内使用 Chromium，Linux 专用退出测试需在镜像内运行。具体公开版的已验证范围见 [验证说明](docs/VERIFICATION.md)。

发布前提交源码，再运行 `npm run package`，在 `outputs/` 生成带 SHA-256 的源码 ZIP。打包脚本只包含明确白名单；工作目录、个人配置、数据、浏览器资料、依赖和日志均不会进入发布包。测试及可控临时目录可通过 `TEMP`、`TMP`、`npm_config_cache` 和 `PLAYWRIGHT_BROWSERS_PATH` 指定到项目盘。

## 许可

本仓库代码采用 [MIT](LICENSE)，Copyright (c) 2026 Clive-111。游戏和 Discord 的名称、服务及第三方素材属于各自权利人；本仓库不附带游戏资源、账号、存档或登录凭据。
