# Codex 远程控制面板

在你自己的电脑上跑 Codex CLI,然后用手机浏览器通过局域网像 ChatGPT 一样远程控制它。

## 功能(MVP)

- 会话列表:读取 `~/.codex/sessions` 下所有历史会话,按更新时间排序
- 聊天窗口:用户/助手消息,移动端优先的深色界面
- 实时状态:任务运行中/空闲/已停止,运行时长,当前消息流式上屏
- 工具调用时间线:每次 `shell_command`、`apply_patch` 等调用的输入、输出、退出码,可展开查看
- 输入操作:新建会话(选择项目目录)、发送续接消息、停止当前任务、切换会话

按需求范围,本版本不做文件变更 diff 浏览。

## 启动

```powershell
cd D:\codex-web
node server.js
```

也可以双击 `start.bat`。

启动后终端会打印局域网地址,例如:

```text
http://192.168.1.3:4000/
```

手机连同一个 Wi-Fi,用浏览器打开这个地址即可,不需要登录。

## Ubuntu + Cloudflare Tunnel 部署

项目可以直接运行在 Ubuntu 服务器上,并通过 Cloudflare Tunnel 对外提供 HTTPS 访问。Tunnel 只连接本机的 `127.0.0.1:4000`,不需要开放公网端口。

### 1. 准备运行目录和 Codex

安装 Node.js 18 或更高版本,并确认 Codex CLI 可用:

```bash
node --version
codex --version
codex app-server --listen stdio://
```

项目没有第三方 Node.js 依赖,可以直接用 npm 启动:

```bash
npm start
```

如果项目仓库已公开,也可以从 Git 仓库通过 npx 启动(将地址替换为实际仓库):

```bash
npx --yes github:OWNER/REPOSITORY
```

该命令会执行 `codex-web` CLI 入口。首次使用仍需在服务器上准备 Node.js、Codex CLI、`CODEX_HOME` 和访问令牌;生产环境建议使用下面的 systemd 服务。

生产环境使用下面提供的 systemd 服务即可达到同样效果,并支持异常自动重启。

把项目放到 `/opt/codex-web`,并确保运行服务的用户(下面示例为 `ubuntu`)可以读取 Codex 配置和认证信息:

```bash
sudo mkdir -p /opt/codex-web /etc/codex-web
sudo chown -R ubuntu:ubuntu /opt/codex-web
```

复制 `deploy/codex-web.env.example` 到 `/etc/codex-web/codex-web.env`,修改 `CODEX_HOME`、`CODEX_BIN` 和随机的 `CODEX_WEB_TOKEN`。配置文件权限应限制为服务用户:

```bash
sudo chown ubuntu:ubuntu /etc/codex-web/codex-web.env
sudo chmod 600 /etc/codex-web/codex-web.env
```

项目目录必须在 `$CODEX_HOME/config.toml` 中标记为 `trusted` 或 `always`,例如:

```toml
[projects."/home/ubuntu/my-project"]
trust_level = "trusted"
```

### 2. 创建 Cloudflare Tunnel

安装 `cloudflared` 后登录并创建 Tunnel:

```bash
cloudflared tunnel login
cloudflared tunnel create codex-web
cloudflared tunnel route dns codex-web codex.example.com
```

复制 `deploy/cloudflared/config.yml.example` 到 `/home/ubuntu/.cloudflared/config.yml`,将域名和 `<TUNNEL-ID>` 替换为实际值。确保 Tunnel 凭据只能被 `ubuntu` 读取:

```bash
chown -R ubuntu:ubuntu /home/ubuntu/.cloudflared
chmod 700 /home/ubuntu/.cloudflared
chmod 600 /home/ubuntu/.cloudflared/*.json
```

### 3. 使用 systemd 常驻运行

复制两个服务文件:

```bash
sudo cp deploy/systemd/codex-web.service /etc/systemd/system/
sudo cp deploy/systemd/cloudflared-codex-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now codex-web.service
sudo systemctl enable --now cloudflared-codex-web.service
```

检查状态和日志:

```bash
systemctl status codex-web cloudflared-codex-web
journalctl -u codex-web -f
journalctl -u cloudflared-codex-web -f
```

访问 `https://codex.example.com/?token=你的令牌`。页面会保存令牌并清理地址栏中的参数。建议同时使用 Cloudflare Access 限制允许访问的账号,并保留 `CODEX_WEB_TOKEN`。

Cloudflare Tunnel 使用出站连接,因此不需要对公网开放 4000 端口。若启用了 UFW,可以保持该端口只对本机可用:

```bash
sudo ufw deny 4000/tcp
```

## 配置

| 环境变量 | 作用 | 默认值 |
| --- | --- | --- |
| `PORT` | 监听端口 | `4000` |
| `CODEX_BIN` | Codex 可执行文件路径 | 自动在 npm 全局目录中查找 |
| `CODEX_HOME` | Codex 配置/会话目录 | `~/.codex` |
| `CODEX_WEB_TOKEN` | 可选的局域网访问令牌 | 不启用 |
| `CODEX_ALLOW_UNTRUSTED_CWD` | 允许 API 使用未列入 trusted 的目录 | `0` |

项目目录下拉框来自 `~/.codex/config.toml` 中 `trust_level = "trusted"` 的项目。

如果设置了 `CODEX_WEB_TOKEN`，首次访问时使用 `http://<电脑IP>:4000/?token=<令牌>`，页面会自动保存令牌并清理地址栏中的参数。

## 安全注意

默认仍保持免登录，方便在可信局域网中使用；但它等于把电脑上的 Codex 能力开放给局域网，任何能访问到地址的人都可以让你的电脑执行命令(本机 config 是 `approval_policy = "never"` + `danger-full-access`)。如果网络不完全可信，请设置 `CODEX_WEB_TOKEN` 启用令牌保护，并只在必要时开放 Windows 防火墙端口。

首次使用如手机连不上,请在 Windows 防火墙中放行 Node.js 的入站连接(私有网络),或在管理员 PowerShell 中执行:

```powershell
netsh advfirewall firewall add rule name="codex-web" dir=in action=allow protocol=TCP localport=4000
```

## 架构

```text
手机浏览器
   │  HTTP API + SSE(实时事件)
   ▼
Node.js 后端(server.js)
   │  child_process 启动
   ▼
codex exec --json / codex exec resume
   │  写入
   ▼
~/.codex/sessions/rollout-*.jsonl
```

后端每次"新建会话/发消息"都会拉起一个 `codex exec` 或 `codex exec resume` 进程,解析 stdout 拿到会话 ID,同时增量读取会话 JSONL 文件,把归一化后的事件通过 SSE 推给前端。历史会话直接解析 `~/.codex/sessions`,不需要额外数据库。

任务结束后,后端会自动执行 `codex migrate-rollouts --apply --thread <id>`,将网页创建的会话同步到新版 Codex CLI 使用的分页会话索引,因此它们也会出现在 CLI 的会话列表中。

## 已知限制

- 实时推送只针对本服务启动的会话;Codex Desktop / IDE 里已经开着的会话在面板里只能看到历史记录
- 同一个会话同时只允许一个任务在跑,运行中不能发新消息
- "停止"在 Windows 上通过 `taskkill /T /F` 强杀进程树,未保存的中间状态可能丢失
- 默认不启用鉴权;如果网络不完全可信,请设置 `CODEX_WEB_TOKEN`,并配合 Cloudflare Access 使用
