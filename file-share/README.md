# 下载服务（本机文件分享 MCP）

把本机文件发布成下载链接的 MCP 服务器。MCP 注册名 `download-service`，显示名“下载服务”，
skill 名同样用 `download-service`。

标识符为什么用英文而不是中文：MCP 规范要求工具名匹配 `^[a-zA-Z0-9_-]{1,64}$`，客户端会把
服务器名拼进工具名（`mcp__<服务器名>__<工具名>`）。ZCode 的 `normalizeMcpServerNameKey` 只做
trim 和 toLowerCase，不过滤非 ASCII，中文服务器名会产出 `mcp__下载服务__share_upload` 这种
不合规工具名，有被拒的风险。所以标识符用 ASCII，显示名用中文。

## 程序架构

```
ZCode（会话/模型）
  └─ MCP 服务器“下载服务” stdio，按需拉起，无常驻进程
       server.mjs
       工具：share_upload / share_list / share_verify / share_doctor
       后端（可插拔，backends/*.mjs）：
         local    → 本机只读 HTTP 服务（长期链接用这个）
         filekiwi → file.kiwi 第三方托管，90 小时后失效
       状态：data\uploads.json
                    │ 发布 = 把文件硬链接进 service/storage/<id>/
                    ▼
   本机下载服务（常驻，detached，PID 文件管理）
       service/server.mjs   HTTP 38217 on 0.0.0.0
         GET  /               密码门 + 文件列表（按发布时间倒序）
         POST /login          校验密码 → 会话 Cookie
         GET  /logout
         GET  /s/<8位短码>     短链接下载（支持 Range 断点续传）
         GET  /f/<id>/<token> 早期长链接，保留兼容
         GET  /healthz
         只读：非 GET/HEAD 一律 405，没有任何上传/删除接口
       service/manage.mjs   start / stop / restart / status
       service/config.mjs   解析 port / bind / publicBase / password
       service/config.json  部署配置（唯一需要手改的文件）
       service/storage/     实体文件（硬链接）+ meta.json
                    │ 可选
                    ▼
   frp 内网穿透（已下载，未启用）
       frp/frpc.exe v0.71.0（已对照官方 SHA256 校验）+ frpc.toml + manage.mjs
```

有三条设计主线：

1. 上传入口只存在于本机。MCP 工具只接受本地文件路径，不接受 URL；下载服务没有上传接口，
   发布靠本机进程直接写文件系统。也就是说“仅限本机上传”是结构上的保证，不靠权限判断。
2. 下载服务只读。网络上不存在任何写入路径，非 GET/HEAD 一律 405。
3. 后端可插拔。`backends/*.mjs` 导出统一的 `upload` / `verify`，加后端不用改主逻辑。

## 它解决什么

原本用 file.kiwi 传文件，链接 90 小时后失效，每次还得重新写一遍代码。现在封装成 4 个 MCP 工具，
会记录每次上传的凭据和有效期，随时可以校验链接是否还活着；另外加了第二个后端，
本机自建下载服务，链接不自动过期。

上传入口只存在于本机这一点值得单独说明：工具只接受本地文件路径，不接受 URL，而本机下载服务
本身也是只读的。它根本没有上传接口，发布文件靠本机进程直接写文件系统。

## 目录结构

```
C:\Users\Administrator\.zcode\mcp\file-share\
├── server.mjs              MCP 服务器主体（4 个工具的实现在这里）
├── backends\
│   ├── filekiwi.mjs        后端 A：file.kiwi（免注册、端到端加密、90 小时过期）
│   └── local.mjs           后端 B：本机下载服务（不自动过期）
├── service\                本机下载服务
│   ├── server.mjs          HTTP 服务（只读；Range 支持；token 校验）
│   ├── manage.mjs          start / stop / restart / status
│   ├── storage\            已发布文件的实体 + meta.json
│   ├── service.pid         运行时的 PID
│   └── service.log         服务日志
├── lib\
│   └── store.mjs           上传索引的读写
├── data\
│   └── uploads.json        上传历史（含校验凭据，勿外发）
├── tools\
│   ├── selftest.mjs        协议自检 / 维护工具
│   └── self-test.txt       自检用的小文件
├── package.json
├── README.md
└── node_modules\           依赖
```

## 两个后端

| 后端 | 链接形态 | 有效期 | 适合 | 代价 |
|---|---|---|---|---|
| `filekiwi`（默认） | `https://file.kiwi/xxx#key` | 90 小时后失效 | 把文件传给任何人，本机不必在线 | 第三方托管；到期要重传 |
| `local` | `http://<本机>/f/<id>/<token>` | 不自动过期 | 长期可用的链接、自己反复下载 | 本机服务必须在线；默认只有本机能访问 |

调用时用 `share_upload` 的 `backend` 参数选择，不传就用默认的 `filekiwi`。

## 四个工具

| 工具 | 用途 |
|---|---|
| `share_upload` | 上传本地文件，返回下载链接、记录 ID、过期时间。`backend` 选后端，`background=true` 异步传超大文件 |
| `share_list` | 列出上传历史（含剩余有效期）和进行中的任务 |
| `share_verify` | 检查文件是否还在、是否完整。发链接给别人之前先跑一次 |
| `share_doctor` | 运行环境、ZCode 注册状态、本机服务状态、启停维护步骤、故障处理表 |

## 本机下载服务

设计上就是只读的。对外开放的只有 `GET /f/<id>/<token>` 下载、`GET /healthz` 探活，以及
`GET /` 索引页（仅 loopback 可见）。写操作一律 405，所以网络上不存在任何写入路径。

- 链接里的 `<token>` 是 128 位随机串，猜不到；不带正确 token 返回 403。
- 索引页只对 loopback 客户端可见，外部访问返回 404，不会泄露已发布文件清单。
- 支持 HTTP Range，大文件可以断点续传。
- 发布时优先用硬链接（同一磁盘卷上不额外占空间），跨卷时自动退回复制。

启停：

```bash
cd C:\Users\Administrator\.zcode\mcp\file-share
node service\manage.mjs start     # 启动（幂等）
node service\manage.mjs status    # PID + 健康检查 + 已发布数量
node service\manage.mjs stop
node service\manage.mjs restart
```

用 `local` 后端上传时，如果服务没在跑，会自动拉起，不需要手动 start。

默认只监听 `127.0.0.1`，也就是只有本机能访问。要让别的设备下载，有两种做法。

一是走局域网，手机连同一个 Wi-Fi 时用这个，把服务绑到所有网卡：

```bash
set FILE_SHARE_BIND=0.0.0.0
node service\manage.mjs restart
```

然后用 `ipconfig` 查到本机局域网 IP，链接就是
`http://<本机局域网IP>:8099/f/<id>/<token>`。此时服务对整个局域网可达，靠 128 位 token 保护。
不用的文件建议及时从 `service\storage\` 删掉。

二是走公网，装 cloudflared 后开一条临时隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:8099
```

它会输出一个临时的 `*.trycloudflare.com` 地址，不需要任何账号，但每次重启都换新地址，
官方也标注了“仅供测试”。想要固定域名需要 Cloudflare 账号和自己的域名。

撤销分享：删掉 `service\storage\<id>\` 整个目录，链接立刻返回 404。

## 部署到公网（当前配置）

服务现在已绑定所有网卡，端口 38217，等待在服务商侧开放端口。

### 当前参数

| 项目 | 值 |
|---|---|
| 监听端口 | 38217（非常用端口；避开了 Windows 动态端口段 49152+，不会和出站连接抢） |
| 监听地址 | `0.0.0.0`（所有网卡） |
| 局域网地址 | `http://<本机局域网IP>:38217` |
| 出口公网 IP | `<公网IP>`（由 icanhazip / ifconfig.me / ipinfo.io / ip.sb 一致确认） |
| 配置文件 | `service\config.json` |

### 这台机器不在家用路由器后面

本机只有一个非环回地址，静态手工配置，网卡名由服务商指定，出口公网 IP 由运营商或 NAT 提供。
这是云主机或运营商 NAT 环境的典型特征，不是普通家庭宽带。

所以开放端口的方式不一样：不是在自家路由器上做端口转发，而是在服务商控制台或安全组里放行
入站 TCP 38217，并确认它 1:1 映射到本机那个私网地址。如果这台机器在办公网或校园网里，
就得找网络管理员，或者改走 frp / cloudflared，见后面几节。

### 本机防火墙

已创建入站放行规则，否则外部连进来会被本机拒掉：

```
规则名：file-share download service (TCP 38217)
方向：入站   协议：TCP   端口：38217   动作：允许   配置文件：全部
```

撤销：

```powershell
Remove-NetFirewallRule -DisplayName "file-share download service (TCP 38217)"
```

### 开机自启（解决重启后链接失效）

下载服务是个 detached 进程，不会在重启后自动运行。后果是重启后所有链接都打不开，直到有人用一次
本机上传（`share_upload` 会自动拉起服务）或者手动 `manage.mjs start`。这条恢复路径实测确认过：
停掉服务后链接立刻失效，触发一次本机上传，服务自动起来，重启前的旧短链接全部复活，
因为短码存在 `meta.json` 里，服务会从磁盘重新加载。

计划任务补的是“没人碰它”时的空档：

```powershell
# 安装 / 重装（可重复执行）
powershell -ExecutionPolicy Bypass -File "C:\Users\Administrator\.zcode\mcp\file-share\service\autostart.ps1"

# 卸载
powershell -ExecutionPolicy Bypass -File "C:\Users\Administrator\.zcode\mcp\file-share\service\autostart.ps1" -Remove
```

任务名 `download-service-autostart`，触发条件是“登录时 + 延迟 20 秒”，动作为
`node.exe "…\service\manage.mjs" start`，失败自动重试 3 次。

注意触发条件是登录时而不是开机时，机器重启后如果没有人登录，服务仍然不会运行。这样选是因为
以 SYSTEM 身份开机运行会让 storage 里新文件归 SYSTEM 所有，还会和用户会话里手动启停的实例
抢同一个 PID 文件和端口，运维上很别扭；而“登录时”与本机 ZCode 自身的运行前提（需要已登录的会话）
是一致的。真需要开机即启动，可以把触发器换成 `-AtStartup` 并接受上述代价。

脚本必须以 UTF-8 BOM 保存。Windows PowerShell 5.1 会把无 BOM 的 `.ps1` 按系统 ANSI 读取，
脚本里的中文会破坏语法解析，这个坑已经踩过一次。

### 从外部验证是否真的通了

服务商那侧开完之后，用这个从第三方视角探测。比本机 curl 可靠，本机 curl 公网 IP 会因为
NAT 回环不支持而失败，那是正常现象，不代表没通。

```bash
curl -s -X POST https://portchecker.io/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"host":"<公网IP>","ports":["38217"]}'
```

返回 `"status":true` 就是通了。2026-09-21 实测基线是 `"status":false`，即当时尚未开放。

### 换端口 / 换对外地址

编辑 `service\config.json` 后重启服务：

```json
{
  "port": 38217,
  "bind": "0.0.0.0",
  "publicBase": "http://<公网IP>:38217",
  "storage": ""
}
```

```bash
node service\manage.mjs restart
```

`publicBase` 决定生成的链接里用哪个地址，留空则自动使用局域网 IP。如果公网 IP 会变，
建议填一个 DDNS 域名，否则每次变 IP 后要改这里并重新发布。
环境变量 `FILE_SHARE_PORT` / `FILE_SHARE_BIND` / `FILE_SHARE_PUBLIC_BASE` 优先级高于配置文件。

### 短链接与文件列表页

下载链接是短码形式：`http://<地址>:38217/s/<8位短码>`，例如 `/s/CZumg6mV`。

- 短码字符集排除了 `0/O/1/l/I`，避免口述或手抄出错。
- 8 位短码约 47 位熵（58^8 ≈ 1.3×10¹⁴），比原来的 128 位 token 弱得多，但足以抵御随机猜测。
  代价是短链接的保密性明显低于原来的长链接，见下面的安全说明。
- 旧的 `/f/<id>/<token>` 长链接仍然可用，已经发出去的链接不会失效。
- 给已有文件补短码是服务启动时自动做的，日志里会写 `assigned short codes to N existing file(s)`。

首页文件列表（`GET /`）输入密码后可看到所有文件，按发布时间从新到旧排列，显示文件名、大小、
发布时间和短链接。页面很朴素，没有多余功能。

```json
// service/config.json
{ "password": "CHANGE_ME", ... }
```

- 密码存在 `service/config.json` 的 `password` 字段，改完 `node service\manage.mjs restart` 生效。
- 留空则文件列表整体禁用（返回 403），而不是变成公开，避免误配导致清单裸露。
  此时直链 `/s/<code>` 不受影响。
- 登录失败有限流：同一 IP 10 分钟内失败 8 次后跳到 `/?e=slow`。实现上先校验密码、只对失败计次，
  所以限流永远不会挡住正确密码，用户不会因为别人（或自己之前的）失败尝试被锁在门外。
  它只能拖慢暴力破解，挡不住针对弱密码的定向尝试。
- 登录态是两个无状态 HMAC 签名 cookie。没有用内存会话，因为服务会重启，内存会让长有效期失去意义。

| Cookie | 有效期 | 续期方式 | 作用 |
|---|---|---|---|
| `fs_session` | 30 天 | 滑动，每次已认证访问都重新计时 | 日常门禁，实际决定现在能不能看列表 |
| `fs_remember` | 180 天 | 只在显式登录时续期 | 短 cookie 失效后凭它静默补发新的短 cookie |

  净效果是连续使用不会掉线，间隔很久再回来（短 cookie 已过期）也不会被要求输密码，直到半年为止。
  每次重新登录会把半年重新起算。

- 两者都是 `HttpOnly; SameSite=Lax`。因为服务是纯 HTTP，无法加 `Secure`，路径上可被截获。
- 签名密钥在 `service/cookie-secret.txt`，首次启动自动生成（权限仅限管理员）。删掉它即可一次性
  作废所有已发出的令牌，这是唯一的全量吊销手段。
- “退出”只清当前浏览器的两个 cookie。无状态令牌无法单点吊销，这是刻意的取舍，换来的是重启不丢登录态。
- 登录成功后是 302 跳转，失败也是 302（跳到 `/?e=bad`），全程 POST/Redirect/GET，
  所以刷新页面不会再触发浏览器那个“重新提交表单”提示。

### 网页上传

登录后列表页顶部会出现上传控件，可一次选多个文件，带进度显示。上传完成的文件会立刻出现在列表里
并生成短链接，即对外可下载。

```json
// service/config.json
{ "upload": "local", "uploadMaxMb": 512 }
```

| `upload` | 谁能上传 | 说明 |
|---|---|---|
| `off` | 没有人 | 回到纯只读；列表页也不显示上传控件 |
| `local` | 只有从本机发起的请求 | 保持“仅限本机上传”的原始约束 |
| `session`（当前启用） | 任何登录成功的人 | 手机、外网都能传，风险见下 |

另有每日额度兜底（`uploadDailyMb` 默认 5120、`uploadDailyCount` 默认 200），计数落在
`<存储目录>/.upload-quota.json`，按 UTC 日期，次日自动重置，重启不会清零。额度用尽返回 429；
单文件若会使当日累计超额也拒绝（413）。这是为了在密码被猜中时，把最坏情况从塞满磁盘
限制成限量写入。

计数文件跟着存储目录走，不是放在 service 目录。否则两个实例或者切换存储目录会互相串账，
这个坑实际踩到过。

实现要点：

- 上传永远要求先登录，三种模式都一样。`local` 只是额外要求请求来源是本机。
- “本机”判定为 remote address 是 loopback，或者属于本机自己的任一网卡地址。因为在本机用浏览器
  访问时，走 `127.0.0.1` 或局域网 IP 都可能，只认 loopback 会误判。
- 不允许上传时不渲染上传控件，避免对外暴露“这里有写入能力”。
- 用裸请求体而不是 multipart，文件名走 `x-filename` 头，因此不需要 multipart 解析器，
  服务端依旧零依赖。请求体直接流式落盘，大小上限边写边判，超限立即中止并删除半截文件。
- 文件名会做清洗（去路径分隔符与控制字符），不会覆盖已有文件。
- 上传的文件以 `Content-Disposition: attachment` 下发，浏览器不会内联渲染，
  因此不能被当成钓鱼或挂马页面使用。

#### 改成 session 之前请想清楚

这会把一个只读的公开服务变成公开的写入目标，而且当时用的密码只有三位数字，穷举是瞬间的事。

- 任何猜到密码的人都能往这台机器写文件，扫描器会主动寻找这种开放上传点。
- 后果包括磁盘被塞满、被用来托管违法内容，而责任落在机器所有者身上。
- 上传的文件默认对外可下载，等于你替别人做了免费托管。

如果确实需要远程上传，先把密码换成强密码。一边是一行配置的代价，一边是上面这些风险，
建议保持 `local`。

### 公网暴露的安全边界

这是明文 HTTP，没有 TLS，有几点需要理解清楚。

- 下载链接的 8 位短码是唯一的访问控制。谁拿到链接谁就能下载；短码比原来的 128 位 token 弱得多，
  所以不要把短链接贴到公开场合。
- 文件列表页现在公网可访问，只靠密码挡着。三位数字的密码可被瞬间枚举，虽然限流会拖慢，
  但这个列表实际上接近公开。列表里会显示每个文件的完整下载链接，所以一旦密码被猜中，
  等于所有文件都泄露。想收紧就改成一个强密码。
- 传输过程不加密，路径上的运营商和任何中间节点都能看到文件内容和登录 Cookie。
  要加密得上 HTTPS，那需要域名加证书。
- 服务是只读的，没有任何写入路径，POST/PUT/DELETE 一律 405，外部无法上传或删除。
- 不要往这个服务上放敏感文件，比如证件、密钥、财务、私人照片。它适合传书、安装包、
  公开资料这一类。
- 撤销分享的方法是删掉 `service\storage\<id>\` 目录，链接立刻失效。

## frp 隧道（把本机服务暴露到公网）

本机下载服务默认只监听 `127.0.0.1`。用 frp 把它映射出去，需要对端有一台带公网 IP 的机器跑
frps，本机只需要 `frpc` 客户端。

### 当前状态

- `frpc.exe` v0.71.0 已装好：`frp\frp_0.71.0_windows_amd64\frpc.exe`，下载后对照过官方
  `frp_sha256_checksums.txt`，校验一致。
- `frp\frpc.toml` 已写好模板，但 `serverAddr` / `token` / `remotePort` 还是 `CHANGE_ME`，
  需要先确定 frps 服务方才能填。
- 管理工具：`frp\manage.mjs`。

### 命令

```bash
cd C:\Users\Administrator\.zcode\mcp\file-share
node frp\manage.mjs up https://your-tunnel-url    # 启动隧道并记录对外地址
node frp\manage.mjs status                        # PID / 是否已连接 / 当前对外地址
node frp\manage.mjs set-base <新地址>              # 隧道换了地址时更新
node frp\manage.mjs down                          # 停止并清除对外地址
node frp\manage.mjs logs 30                       # 看 frpc 日志
```

`manage.mjs up` 会先用 `frpc verify` 校验配置再启动，配置有问题会直接报出来。

对外地址记在 `frp\public-base.txt`，`backends/local.mjs` 每次发布时都会重新读它，
所以隧道换了域名之后，之后生成的新链接会自动用新地址，不需要重启 ZCode。

### 改配置时的坑

`transport.useEncryption` 和 `transport.useCompression` 是代理级字段，必须写在 `[[proxies]]` 里面。
写到全局会得到 `json: unknown field "useCompression"`，配置校验直接失败，这个错误本项目实际踩到过。
全局的加密开关是 `transport.tls.enable`。

改完一定要校验：

```bash
frp\frp_0.71.0_windows_amd64\frpc.exe verify -c frp\frpc.toml
```

### 公共 frps 能看到你的明文

这是选服务方之前必须知道的事。frp 官方的说法是：

> `transport.useEncryption` and STCP functions can effectively prevent traffic content from
> being stolen during communication, but cannot determine whether the other party's identity
> is legitimate, posing a risk of man-in-the-middle attacks.

技术结论：

- frp 的 TLS 和 `useEncryption` 都是逐跳加密，只覆盖 frpc↔frps 这一段。frps 那一端持有密钥，
  能读取也能篡改经过它的所有流量。
- 用默认随机证书且客户端不校验服务端证书时，连主动中间人攻击都挡不住。默认 TLS 只保证机密性，
  不保证对端身份。
- 走 `type = "http"` 更糟，frps 会解析你的 HTTP 请求，内容、头部、子域名它都能看到和改写。
- 走 `type = "tcp"`（本项目默认）只是转发字节流，但在中继点仍然可以嗅探和改写。
- 服务方还能看到你的家宽 IP、frpc token、隧道名、目标端口、每个访问者的 IP、时间和流量大小。

所以公共 frps 等于把文件内容交给那个运营者。要真正安全只有两条路：一是自己跑 frps，
找一台有公网 IP 的机器，除了 VPS 商没有第三方能看到流量；二是在应用层做端到端加密，
发布时在本地加密，密钥只放在链接的 `#` 片段里，由下载端解密，filekiwi 后端就是这个模式，
这样 frps 只能看到密文。本项目尚未实现第二条，如果要走公共 frps 传敏感文件，建议先加上。

### 免费 frps 服务方（2026-09 调研）

| 服务 | 免费额度 | 实名认证 | 备注 |
|---|---|---|---|
| ChmlFrp (chmlfrp.net) | ¥0 永久，8 Mbps，4 条隧道，不限流量，送三级域名 | 站点与 TOS 中未见实名要求 | 有公开节点 API，19 个免费节点；国内节点建站需 ICP 备案，选海外节点 |
| OpenFrp (openfrp.net) | 基础服务免费，12 Mb × 节点系数 | 存在实人验证入口，是否强制不明确 | 持证运营方，较正规 |
| 樱花frp (natfrp.com) | 10 Mbps / 2 条隧道 / 5 GiB 月流量 | 强制实名：姓名+身份证号+支付宝刷脸，¥1 | 建站、海外节点必须实名，本项目不建议 |
| 花生壳 / Oray | 1 Mbps、1 GB/月 | 站点有实名入口（很可能需要） | 免费额度太小 |
| 公共 frps 地址列表（GitHub 等） | — | — | 不要用：无法核实是否还在运行，且运营者能看到你的明文和 token |

推荐 ChmlFrp 免费版，无需实名、送三级域名、不限流量。注册后在面板拿到节点地址、端口、token、
分配给你的远程端口，填进 `frp\frpc.toml` 即可。

### 自建 frps 的路

想要完全掌控就得自己有个公网 IP 的机器。免费额度里 Oracle Cloud Always Free 最划算
（2 OCPU / 12 GB ARM、10 TB 月流量），但要绑信用卡，GCP/AWS/Azure 同样需要卡。
便宜 VPS（RackNerd、Vultr 等，约 $1–3/月，多支持支付宝）也可以。

已知问题：Windows Defender 会把 `frps.exe` 判定为威胁并阻止执行，本机实测，日志里有
ThreatID 2147939874。这是 frp 服务端的常见误报，反向代理服务端常被攻击者滥用。
`frpc.exe` 不受影响。要自建 frps 需要加杀软排除项，这属于削弱安全防护的操作，
必须先征得用户明确同意。

### 备选：Cloudflare Tunnel

不想注册任何 frp 服务的话，`cloudflared` 是更省事也更可信的方案：

```bash
cloudflared tunnel --url http://127.0.0.1:8099
```

不需要账号、不需要域名、不需要备案，直接给你一个临时 `*.trycloudflare.com` 地址。
代价是地址每次重启都变、官方标注“仅供测试开发”、中国大陆访问可能偏慢。
固定域名需要 Cloudflare 账号和自己的域名。它同样在边缘终止 TLS，所以明文内容对它也可见，
但相比匿名的个人 frps，Cloudflare 是有法律和隐私框架的大公司。

## 安装与启动（MCP 本体）

本服务器由 ZCode 按需拉起（stdio 传输），不需要常驻进程。

注册位置在 `C:\Users\Administrator\.zcode\cli\config.json`：

```json
{
  "mcp": {
    "servers": {
      "download-service": {
        "type": "stdio",
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": ["C:\\Users\\Administrator\\.zcode\\mcp\\file-share\\server.mjs"],
        "cwd": "C:\\Users\\Administrator\\.zcode\\mcp\\file-share",
        "timeoutMs": 900000,
        "enabled": true
      }
    }
  }
}
```

配置要点，都是踩过的坑：

- `command` 必须是字符串，参数放 `args` 数组。写成数组会导致客户端报 `command.trim is not a function`。
- 这里用 `node.exe` 的绝对路径，不依赖 PATH。Node 升级或换机器后要同步改。
- ZCode 的 MCP 配置 schema 是严格的，出现未知键整条配置会被静默丢弃，工具直接不出现。
- 配置文件里不支持 `${...}` 模板变量，必须写绝对路径。
- `timeoutMs` 设成 900000（15 分钟），因为大文件上传可能超过默认的 30 秒。

## 日常维护

```bash
cd C:\Users\Administrator\.zcode\mcp\file-share
node tools\selftest.mjs                                    # 握手 + 列工具 + doctor + 列历史 + 校验
node tools\selftest.mjs --upload .\tools\self-test.txt     # 附加一次真实上传
node tools\selftest.mjs --upload <文件> --backend local    # 测本机服务后端
node server.mjs --doctor                                   # 只看健康报告
```

自检脚本真实地按 JSON-RPC 协议与服务器对话，和 ZCode 的调用方式一致。

改了代码或依赖后，重启 ZCode 会话（或整个客户端），然后在 Settings → MCP 里确认
`download-service` 状态是 connected。

更新依赖：`cd` 到工程目录后 `npm install`。

看日志：MCP 的诊断信息带 `[download-service]` 前缀，走 stderr（stdout 被 JSON-RPC 独占，
写任何东西进去都会破坏协议）；本机服务写 `service\service.log`，前缀 `[local-share]`。

## 故障处理

| 症状 | 原因 | 处理 |
|---|---|---|
| Settings → MCP 里没有 download-service | 配置 JSON 语法错误，或含未知键被严格 schema 丢弃 | 校验 `~/.zcode/cli/config.json`；只保留 `type/command/args/cwd/env/enabled/timeoutMs` |
| 状态 failed，报 `spawn ENOENT` | `command` 指向的可执行文件不存在 | 确认 `C:\Program Files\nodejs\node.exe` 还在 |
| 工具调用超时 | 上传耗时超过 `timeoutMs` | 已设 15 分钟；更大的文件用 `background: true` |
| filekiwi 链接 404 | 超过 90 小时保留期 | `share_verify` 确认后重传，或改用 `local` 后端 |
| local 链接打不开 | 服务没跑，或链接是 127.0.0.1 只有本机能访问 | `node service\manage.mjs start`；外部访问见前面两种做法 |
| local 上传报端口占用 | 8099 被别的程序占用 | 用 `FILE_SHARE_PORT` 换端口 |

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `FILE_SHARE_MAX_MB` | 4096 | 单文件上传上限 |
| `FILE_SHARE_PORT` | 8099 | 本机服务端口 |
| `FILE_SHARE_BIND` | 127.0.0.1 | 服务监听地址，`0.0.0.0` 表示允许局域网访问 |
| `FILE_SHARE_PUBLIC_BASE` | `http://127.0.0.1:<port>` | 生成链接时使用的对外地址（开了隧道就设成隧道域名） |
| `FILE_SHARE_STORAGE` | `service\storage` | 已发布文件的存放目录 |

## 如何新增一个持久化后端

不需要改 `server.mjs` 的逻辑，加一个后端实现即可：

1. 在 `backends\` 下新建 `xxx.mjs`，导出 `id`、`label`、`retention`、`needsAccount`，以及：
   - `async upload(filePath, { title, onProgress })`，至少返回 `{ url, retentionHours }`
     （不自动过期就给 `null`）
   - `async verify(record)`，返回 `{ alive, complete, missing }`
2. 在 `server.mjs` 顶部 `BACKENDS` 里注册，需要的话把 `DEFAULT_BACKEND` 指过去。
3. 用 `tools\selftest.mjs --upload <文件> --backend xxx` 验证。

候选方案（2026-09 调研结论）：

- Backblaze B2：10GB 永久免费，不要信用卡、不要实名认证，S3 兼容，链接永久。最省事的持久方案。
- GitHub Releases：免费、无需证件，单文件小于 2GiB，但 GitHub 的 ToS 不鼓励当通用存储或 CDN 用。
- Cloudflare R2：10GB 免费额度、零出站费用，但开通走结账流程，可能需要绑定支付方式（未完全证实）。
- 国内服务（七牛云、又拍云、阿里云等）：都要求实名认证。除非确有必要，建议避开。
- 纯临时中转（无需账号）：litterbox（1GB，最长 3 天）、uguu.se（128MB，3 小时）、
  filebin.net（6 天）。注意这个领域正在萎缩，0x0.st 已关闭上传，transfer.sh 公网实例已下线，
  file.io 的 API 实际不可用，不要在这些服务上建长期流程。

## 数据与备份

- `data\uploads.json` 是 MCP 侧的唯一状态，备份它就保留了全部上传历史和校验能力。
- 其中 `apiAuth`（filekiwi 的查询凭据）、`secretKey`（解密密钥）、`localId` 都属敏感信息，
  不要外发这个文件。
- 本机服务的文件实体在 `service\storage\<id>\`，删目录即撤销分享。
- 想删掉某条历史记录，直接编辑 JSON 里的 `uploads` 数组（不会删除服务器上的文件）。
