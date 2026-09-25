---
name: download-service
description: 下载服务（本机文件分享）。把本机文件发布成短链接下载地址，并提供一张密码保护的文件列表页。当用户说“把这个文件发给我 / 传出去 / 生成下载链接 / 怎么把文件弄到手机上 / 看下载服务里有哪些文件”，或需要绕过微信等渠道无法发文件附件的限制、校验旧分享链接是否还有效、排查下载服务故障时使用。
version: 2.0.0
---

# 下载服务（本机文件分享）

本机已注册 MCP 服务器“下载服务”，技术标识符 `download-service`。
提供 4 个工具、2 个后端，以及一个常驻的只读下载服务。

工程目录：`C:\Users\Administrator\.zcode\mcp\file-share\`

想知道当前状态，直接调 `share_doctor`，它返回实时状态、完整维护手册和架构图。

## 为什么技术标识符是英文

MCP 规范要求工具名匹配 `^[a-zA-Z0-9_-]{1,64}$`，客户端会把服务器名拼进工具名
（`mcp__<服务器名>__<工具名>`）。ZCode 的 `normalizeMcpServerNameKey` 只做 trim 和 toLowerCase，
不过滤非 ASCII，所以中文服务器名会产出 `mcp__下载服务__share_upload` 这种不合规工具名，
有被拒的风险。所以用 ASCII 标识符加中文显示名。

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
       service/config.json  部署配置（唯一需要手改的文件）
       service/storage/     实体文件 + meta.json
                    │ 可选
                    ▼
   frp 内网穿透（已下载，未启用）
```

核心设计：上传入口只存在于本机，MCP 只接受本地路径；下载服务没有上传接口，
发布靠本机进程直接写文件系统。所以“仅限本机上传”是结构保证，不是权限判断。

## 当前部署（会变，以 share_doctor 为准）

| 项目 | 值 |
|---|---|
| 首页 / 文件列表 | http://<公网IP>:38217/ （密码见 service/config.json） |
| 端口 | 38217，绑定 `0.0.0.0` |
| 局域网地址 | `http://<本机局域网IP>:38217` |
| 短链接格式 | `http://<公网IP>:38217/s/<8位短码>` |
| 防火墙规则 | `file-share download service (TCP 38217)`（已放行入站） |

## 四个工具

| 工具 | 用途 |
|---|---|
| `share_upload` | `path` 必填（本地绝对路径）；可选 `backend` / `title` / `background`。返回短链接、记录 ID、有效期 |
| `share_list` | 上传历史（含剩余有效期）和进行中的任务 |
| `share_verify` | 校验文件在服务端是否仍在、是否完整 |
| `share_doctor` | 实时状态 + 维护手册 + 架构图 |

## 使用流程

1. 用户要分享文件，调 `share_upload`，把返回的链接原文给用户。
2. 链接是纯文本，能过微信等任何文本渠道。
3. 告知有效期：`local` 后端不过期但依赖本机服务在线；`filekiwi` 后端 90 小时后失效。

## 常用维护操作

```bash
cd C:\Users\Administrator\.zcode\mcp\file-share
node tools\selftest.mjs                                   # 全量自检（真实走 JSON-RPC）
node tools\selftest.mjs --upload <文件> --backend local    # 附加真实上传
node server.mjs --doctor                                  # 只看维护手册
node service\manage.mjs status                            # 本机服务状态
node service\manage.mjs restart                           # 改完 config.json 后重启
```

改端口、绑定、对外地址、密码：编辑 `service\config.json` 后 `node service\manage.mjs restart`。
`publicBase` 决定链接里用哪个地址，留空则自动用局域网 IP。公网 IP 若会变，建议填 DDNS 域名，
否则 IP 一变，已经发出去的链接全部失效。

重启后链接打不开：下载服务是 detached 进程，重启不会自动运行。已有计划任务
`download-service-autostart`（登录时 + 延迟 20 秒）负责拉起；若它不存在或被删，
用 `service\autostart.ps1` 装回来，或者手动 `node service\manage.mjs start`。
注意任何一次本机上传（`share_upload` 用 local 后端）都会自动拉起服务，且旧短链接会全部复活。

撤销某个分享：删掉 `service\storage\<id>\` 目录，链接立刻失效。

外部可达性用第三方探测，别用本机 curl 公网 IP，NAT 回环通常不支持，会误判：

```bash
curl -s -X POST https://portchecker.io/api/v1/query -H "Content-Type: application/json" \
  -d '{"host":"<公网IP>","ports":["38217"]}'
```

`"status":true` 即外部可达。

## 安全边界（必须让用户知情）

- 明文 HTTP，没有 TLS。路径上的运营商和中间节点能看到文件内容和登录 Cookie。
- 短链接的 8 位短码是下载的唯一访问控制（约 47 位熵）。谁拿到链接谁就能下载。
- 文件列表页公网可访问，只靠密码挡着。密码若很短（如三位数字），列表实际接近公开；
  而列表会显示每个文件的完整链接，密码被猜中即等于全部文件泄露。登录失败有限流
  （同 IP 10 分钟 8 次后 429），但只能拖慢，挡不住定向枚举。
  用户若坚持用短密码，明确说明这个后果，别默默照做。
- 不要发布敏感文件（证件、密钥、财务、私人照片），除非用户明确要求并知情。
  适合传书、安装包、公开资料。
- 网页上传：登录后列表页有上传控件（多选 + 进度），上传即发布并生成短链接。
  由 `service/config.json` 的 `upload` 控制：`off` 纯只读（也不显示控件）；
  `local` 只允许从本机发起；`session`（当前启用）任何登录成功的人都能传。
  三种模式都要求先登录。另有每日额度兜底（`uploadDailyMb` / `uploadDailyCount`，
  计数在 `<存储目录>/.upload-quota.json`），额度用尽返回 429，单文件会超当日累计则 413。
  单文件上限 `uploadMaxMb`，超限中止并删除半截文件。文件名会清洗，不覆盖已有文件。
- 当前是 `session` 模式，意味着只要有人猜到密码就能往这台机器写文件，密码强度是唯一的门槛。
  用户知情并选择了这个模式。后续若出现异常（磁盘暴涨、陌生文件），第一反应应该是把 `upload`
  改回 `local` 或 `off`，并检查 `service/storage/` 里有没有陌生条目。不要擅自改回，
  但要在用户询问或发现异常时主动指出这一点。
- 不要把 `upload` 改成 `session` 而不提醒用户，这会把只读的公开服务变成公开写入目标，
  而这类部署的密码往往很短。扫描器会主动找开放上传点，后果是磁盘被塞满或被用来托管违法内容，
  责任在机器所有者身上。用户若坚持，先建议换强密码，并明确说明这个后果。
- 登录态是两个无状态 HMAC 签名 cookie：`fs_session` 30 天滑动续期（日常门禁），
  `fs_remember` 180 天，只在显式登录时续期（短 cookie 失效后凭它静默补发新的短 cookie）。
  净效果是最长半年不用重新输密码，每次重新登录把半年重新起算。签名密钥在
  `service/cookie-secret.txt`，删掉它可一次性作废所有已发出的令牌，这是唯一的全量吊销手段，
  因为无状态令牌无法单点吊销。改成内存会话会让长有效期失去意义，服务会重启。
- 登录成功与失败都返回 302（失败跳 `/?e=bad`），所以刷新页面不会触发浏览器那个
  “重新提交表单”提示。改登录流程时必须保持 POST/Redirect/GET，否则这个提示会回来。

## 已知的坑

- 这台机器不是家用路由器后的机器：网卡只有一个静态私网地址，网卡名由服务商指定，
  出口公网 IP 由运营商或 NAT 提供。开放端口要在服务商控制台做，不是家里路由器。
- `service/config.json` 里 `password` 留空会让文件列表整体禁用（403），不会变成公开。
- 改 `frpc.toml` 后必须 `frpc.exe verify -c frpc.toml`。`transport.useEncryption` /
  `useCompression` 是代理级字段（写在 `[[proxies]]` 内），写到全局会报 `unknown field`。
- frp 的 TLS 是逐跳的（frpc↔frps），frps 那端持有密钥，能读取也能篡改流量。
  用公共 frps 等于把文件内容交给那个运营者，要用户知情后再决定。
- Windows Defender 会拦 `frps.exe`（服务端，常见误报），`frpc.exe` 不受影响。
  给杀软加排除项属于削弱防护，必须先征得用户同意。
- 用 QQ 邮箱自动注册 ChmlFrp 失败：注册页有反机器人层（按钮被透明 div 遮挡，
  定位器点击超时、脚本 click 被忽略）。不要尝试绕过反机器人防护。

## 维护资料位置

- 完整文档：`C:\Users\Administrator\.zcode\mcp\file-share\README.md`
- 实时状态 + 手册：调 `share_doctor`
- 上传索引与凭据：`data\uploads.json`（含 filekiwi 的 apiAuth 与解密密钥，勿外发）
- MCP 注册位置：`~/.zcode/cli/config.json` → `mcp.servers.download-service`
