# 茉莉修仙传助手

支持自动战斗、调息、背包管理、炼制、批量卖出、换装和图鉴。

## Windows 安装

1. 安装 [Node.js 24 LTS](https://nodejs.org/en/download)（最低 22）和 [Chrome](https://www.google.com/chrome/)，安装时保持默认选项。
2. 本页点击 **Code → Download ZIP**，解压到 `D:\moli-xiuxian-helper`。
3. 打开 **命令提示符（CMD）**，运行（路径按实际修改）：

```bat
cd /d "D:\moli-xiuxian-helper"
install.cmd
```

安装成功后启动：

```bat
start.cmd
```

也可以直接双击这两个文件。以后只需双击 `start.cmd`。

打开控制面板：<http://localhost:7081>。使用期间保持电脑和启动窗口开启。

## Docker 安装（二选一）

1. 安装并打开 [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)，使用 Linux 容器模式。
2. 下载并解压源码，在项目文件夹双击 `docker-setup.cmd`。

或在项目目录运行：

```sh
docker compose up -d --build
```

- 控制面板：<http://localhost:7081>
- 游戏浏览器：<http://localhost:7080/vnc.html>

此方式不用另外安装 Node.js 和 Chrome。

## 开始使用

1. 面板点击「打开游戏 / 登录」，在弹出的浏览器中登录；Docker 用户在上面的游戏浏览器地址登录。
2. 回到面板，点击「读取人物」→ 核对名字 →「确认绑定此人物」。
3. 等待自动读取地点、背包、配方和图鉴，选择战斗地点及调息地点，保存后点击「启动挂机」。

卖出地点会自动准备，手动换店也会自动保存。资料没读全时点「刷新全部资料」。

同一账号只运行一份。存档冲突、授权或验证码需在游戏中手动处理；卖出、炼制结果待核对时用「仅核对」，不要删记录重试。需要换号时另解压一份。

## 常见问题

- **找不到 node/npm**：重新安装 Node.js，再打开 CMD，用 `node -v`、`npm -v` 检查。
- **安装失败 / 缺少依赖**：检查网络，在解压后的项目目录重新运行 `install.cmd`。
- **找不到 Chrome**：安装 Chrome，或按下方说明改用 Edge。
- **Docker 启动失败**：先打开 Docker Desktop，等它启动完成后重试。
- **7081 打不开**：确认 `start.cmd` 窗口还在运行；Docker 用户确认容器已启动。
- **端口被占用**：按下方说明修改端口，再启动自己的这份脚本。

<details>
<summary>可选设置：浏览器、端口、代理</summary>

**使用 Edge**：复制 `config.example.json` 为 `config.json`，将 `browserChannel` 改为 `msedge`。已有配置文件直接修改，不要覆盖。

**使用 Chromium**：先运行 `install.cmd`，再在项目目录的 CMD 中执行：

```bat
set "npm_config_cache=%CD%\work\npm-cache"
set "TEMP=%CD%\work\tmp"
set "TMP=%TEMP%"
set "PLAYWRIGHT_BROWSERS_PATH=%CD%\work\pw-browsers"
npx playwright install chromium
```

复制 `config.example.json` 为 `config.json`（已有则直接编辑），将 `browserChannel` 改为 `chromium`。在 `.env` 中添加（没有则新建，路径按实际修改）：

```dotenv
PLAYWRIGHT_BROWSERS_PATH=D:/moli-xiuxian-helper/work/pw-browsers
```

**修改端口或代理**：复制 `.env.example` 为 `.env`，按需修改。已有文件直接编辑。

```dotenv
CONTROL_PORT=7081
VNC_PORT=7080
BROWSER_PROXY_SERVER=
```

`CONTROL_PORT` 是面板端口，`VNC_PORT` 只用于 Docker 游戏画面。代理留空为直连；需要时填写自己的代理地址，Docker 访问本机代理用 `http://host.docker.internal:端口`。

修改后重启自己的这份脚本。

</details>

<details>
<summary>开发与测试</summary>

```sh
npm ci
npm test
```

[验证说明](docs/VERIFICATION.md)。提交修改后运行 `npm run package`，源码包生成在 `outputs/`。

</details>

## 许可

[MIT](LICENSE) · Copyright (c) 2026 Clive-111。游戏及 Discord 的名称、服务和第三方素材属于各自权利人。
