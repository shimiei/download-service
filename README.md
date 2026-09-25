# download-service

给测试环境里的 agent 往外传文件用的。

agent 部署在一台测试机或服务器上，干完活产出了文件（日志、报告、构建产物、截图、导出的数据），
它没法直接把文件递给外面的人。这个仓库提供的下载服务，能让它把文件变成一条纯文本短链接：

```
http://<服务器地址>:38217/s/k7m3xq9p
```

这条链接能贴进微信、飞书、Issue、聊天框，任何能发文字的地方都行，外面的人点开就能下载。
不用登服务器，不用装客户端，不用配共享目录。链接支持 Range，大文件可以断点续传。

## 仓库内容

| 路径 | 说明 |
|---|---|
| [`file-share/`](file-share/) | MCP 服务器源码，Node.js，无构建步骤 |
| [`file-share/server.mjs`](file-share/server.mjs) | MCP 主体，暴露 4 个工具 |
| [`file-share/service/`](file-share/service/) | 本机下载服务：HTTP 服务、启停管理、配置解析、短码、开机自启 |
| [`file-share/backends/`](file-share/backends/) | 可插拔后端：`local`（本机服务）和 `filekiwi`（第三方托管） |
| [`file-share/README.md`](file-share/README.md) | 完整文档：架构、部署、公网暴露、维护、故障处理、安全边界 |
| [`skill/SKILL.md`](skill/SKILL.md) | 给 agent 看的技能说明：触发条件、用法、维护操作 |
| [`MANIFEST.md`](MANIFEST.md) | 打包清单，以及打包时排除了什么 |

## 四个工具

agent 通过 MCP 调用，不需要记命令行：

| 工具 | 用途 |
|---|---|
| `share_upload` | 传本地文件，返回短链接、记录 ID、有效期 |
| `share_list` | 上传历史（含剩余有效期）和进行中的任务 |
| `share_verify` | 校验文件还在不在、完不完整。发链接给人之前先跑一次 |
| `share_doctor` | 实时状态加维护手册加架构图。想了解现状就调它 |

两个后端，用 `backend` 参数选：

- `local` 走本机下载服务，链接不自动过期，适合测试机常驻在线的场景，推荐。
- `filekiwi` 第三方托管，链接 90 小时后失效，但服务器下线了链接也还能用。

## 部署

需要 Node.js 18+ 和一个可写的目录。

```bash
npm install                                          # 装依赖
cp service/config.example.json service/config.json    # 然后改端口、密码、对外地址
node service/manage.mjs start                         # 起本机下载服务
node tools/selftest.mjs                               # 自检（真实走一遍 JSON-RPC）
```

`service/config.json` 里几个关键字段：

| 字段 | 建议值 | 说明 |
|---|---|---|
| `port` | `38217` | 监听端口 |
| `bind` | `0.0.0.0` | 要外部能访问就得绑所有网卡；只自己用就 `127.0.0.1` |
| `publicBase` | `http://<对外地址>:38217` | 决定生成的链接里写哪个地址。填错了链接发出去就是废的 |
| `password` | 设一个强密码 | 文件列表页的密码。留空等于列表整体禁用（403），不会变成公开 |
| `upload` | `local` | 见下方上传模式 |

### 上传模式

`config.json` 的 `upload` 字段有三档：

- `off` 纯只读，不显示上传控件。
- `local` 只允许从本机发起上传。测试机场景用这个就够了，因为 agent 和下载服务在同一台机器上。
- `session` 任何登录成功的人都能上传。这是把只读服务变成公开的写入目标，
  只在确实需要人工从浏览器传文件时才开，并且必须配强密码。

三种模式都要求先登录。另有单文件上限 `uploadMaxMb` 和每日额度
`uploadDailyMb` / `uploadDailyCount` 兜底。

### 注册到 MCP 客户端

在 MCP 配置里加一项，路径按实际部署目录改：

```json
{
  "mcp": {
    "servers": {
      "download-service": {
        "type": "stdio",
        "command": "C:\\Program Files\\nodejs\\node.exe",
        "args": ["<部署目录>\\server.mjs"],
        "cwd": "<部署目录>",
        "timeoutMs": 900000,
        "enabled": true
      }
    }
  }
}
```

再把 [`skill/SKILL.md`](skill/SKILL.md) 装进 agent 的技能目录，它才知道什么时候该用、怎么用。

### 重启后链接打不开

下载服务是 detached 进程，开机不会自己起来。用 `file-share/service/autostart.ps1`
装一个计划任务（登录时加延迟 20 秒）解决。

另外，任何一次本机上传（`local` 后端）都会自动拉起服务，旧短链接会全部复活。

## 安全边界

这套东西的设计前提是方便，不是安全，默认配置是明文 HTTP，没有 TLS。

- 明文传输，路径上的运营商和中间节点能看到文件内容和登录 Cookie。
- 短链接里的 8 位短码就是唯一的访问控制，约 47 位熵。谁拿到链接谁就能下载，
  这正是它能当文本随便发的原因。所以别用来传敏感文件，比如证件、密钥、财务、私人照片。
  适合传安装包、日志、报告、公开资料。
- 文件列表页公网可访问，只靠密码挡着，而列表会显示每个文件的完整链接，
  密码被猜中就等于全部文件泄露。务必用强密码，别用三位数。
- 不要在公网上开 `session` 上传模式。扫描器会主动找开放的上传点，
  后果是磁盘被塞满，或者被用来托管违法内容。
- 撤销某个分享：删掉 `service/storage/<id>/` 目录，链接立刻失效。
- 一次性作废所有登录态：删掉 `service/cookie-secret.txt`，服务会自动重新生成。

公网可达性用第三方探测确认，别在本机 curl 公网 IP，NAT 回环通常不支持，会误判：

```bash
curl -s -X POST https://portchecker.io/api/v1/query \
  -H "Content-Type: application/json" \
  -d '{"host":"<你的公网IP>","ports":["38217"]}'
```

## 这个仓库里没有的东西

打包时刻意排除了以下内容，不是为了省体积，而是因为里面有凭据：

| 排除项 | 原因 |
|---|---|
| `service/config.json` | 含真实密码，提供了 `config.example.json` 占位 |
| `service/cookie-secret.txt` | 会话签名密钥，泄露即可伪造登录 |
| `data/uploads.json` | 含第三方后端的查询凭据与文件解密密钥 |
| `service/storage/` | 已发布文件的实体 |
| `node_modules/`、`frp/` | 可重新安装，frp 是 13MB+ 二进制 |
| `*.log`、`*.pid`、配额文件 | 运行时状态 |

所以直接 clone 下来是不能跑的，得先按上面部署那一节生成自己的 `config.json`。

文档里的地址一律写成 `<公网IP>`、`<本机局域网IP>` 这类占位符，部署时按自己的环境填。

## 更多文档

- 完整文档、公网暴露、frp 隧道、故障处理：[`file-share/README.md`](file-share/README.md)
- agent 的技能说明：[`skill/SKILL.md`](skill/SKILL.md)
- 随时问运行中的服务：调 MCP 工具 `share_doctor`
