# download-service 源码包

这是本机“下载服务”（MCP 名 `download-service`）的完整源码，由部署脚本自动打包。

## 内容

| 路径 | 说明 |
|---|---|
| `file-share/server.mjs` | MCP 服务器主体，4 个工具：share_upload / share_list / share_verify / share_doctor |
| `file-share/lib/` | `store.mjs` 上传索引、`doctor.mjs` 维护手册生成 |
| `file-share/backends/` | 可插拔后端：`local.mjs`（本机 HTTP 服务）、`filekiwi.mjs`（第三方托管） |
| `file-share/service/` | 本机下载服务：`server.mjs` HTTP 服务、`manage.mjs` 启停、`config.mjs` 配置解析、`shortcode.mjs` 短码生成、`autostart.ps1` 开机自启 |
| `file-share/tools/` | `selftest.mjs` 协议自检 |
| `file-share/README.md` | 完整文档：架构、部署、维护、故障处理、安全边界 |
| `skill/SKILL.md` | 给 AI agent 用的技能说明（触发条件、用法、维护、安全边界） |
| `file-share/service/config.example.json` | 配置模板 |
| `MANIFEST.md` | 本文件 |

## 部署方式

```bash
npm install                       # 装 @modelcontextprotocol/sdk / @file-kiwi/node / zod
cp service/config.example.json service/config.json   # 改端口、密码、对外地址
node service/manage.mjs start     # 起本机下载服务
node tools/selftest.mjs           # 自检
```

MCP 注册（ZCode 用户级配置 `~/.zcode/cli/config.json`）：

```json
{ "mcp": { "servers": { "download-service": {
  "type": "stdio",
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["<项目目录>\\server.mjs"],
  "cwd": "<项目目录>",
  "timeoutMs": 900000, "enabled": true } } } }
```

## 刻意排除的内容

打包时剔除了以下内容，不是为了省体积，而是因为里面有凭据：

- `service/config.json`，含真实密码，改用 `config.example.json` 占位
- `service/cookie-secret.txt`，会话签名密钥，泄露即可伪造登录
- `data/uploads.json`，含 file.kiwi 的查询凭据与文件解密密钥
- `service/storage/`，已发布的文件本体
- `node_modules/`、`frp/`（二进制），可重新安装，且 frp 有 13MB+
- 各类 `*.log`、`*.pid`、配额文件，属于运行时状态

## 设计要点

- 上传入口原则上只存在于本机。下载服务默认没有任何可被外部利用的写入路径，
  `upload` 模式为 `local` 时只有本机来源能写。
- 下载服务只读（默认配置下）：非 GET/HEAD 一律 405。
- 发布用硬链接，同卷不额外占磁盘；跨卷自动退回复制。
- 短链接是 8 位随机码，字符集排除 `0/O/1/l/I`，避免口述手抄出错。
- 无状态 HMAC 签名会话，服务重启不掉登录态；删签名密钥即全量吊销。

打包清单（共 17 个文件）：

- file-share/backends/filekiwi.mjs（2016 字节）
- file-share/backends/local.mjs（4529 字节）
- file-share/lib/doctor.mjs（17205 字节）
- file-share/lib/store.mjs（1736 字节）
- file-share/package-lock.json（44494 字节）
- file-share/package.json（410 字节）
- file-share/README.md（29319 字节）
- file-share/server.mjs（13241 字节）
- file-share/service/autostart.ps1（2782 字节）
- file-share/service/config.example.json（227 字节）
- file-share/service/config.mjs（3495 字节）
- file-share/service/manage.mjs（3893 字节）
- file-share/service/server.mjs（28225 字节）
- file-share/service/shortcode.mjs（1208 字节）
- file-share/tools/self-test.txt（323 字节）
- file-share/tools/selftest.mjs（5329 字节）
- skill/SKILL.md（10037 字节）
