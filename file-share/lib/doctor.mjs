// Maintenance report for the 下载服务 (download-service) MCP.
//
// Everything learned about this deployment is written down here, so a future
// conversation can pick it up by calling share_doctor instead of re-discovering it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as store from './store.mjs';
import { loadConfig, lanAddress } from '../service/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // lib/
const ROOT = path.dirname(HERE);

const AUTOSTART_TASK = 'download-service-autostart';

// The service is a detached process, so it cannot survive a reboot on its own.
// This is what closes that gap; report it truthfully rather than assuming.
function autostartStatus() {
  try {
    const r = spawnSync('schtasks', ['/query', '/tn', AUTOSTART_TASK], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    if (r.status === 0) return '已注册（登录时自动启动，延迟 20 秒）';
  } catch {}
  return '未注册。机器重启后服务不会自动起来，链接会一直打不开，直到有人用一次本机上传';
}

const read = (p) => {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
};

const alive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export async function doctorReport({ version, maxMb, backends, defaultBackend }) {
  const cfgPath = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
  let cfgState = '未找到';
  let registeredAs = '否';
  try {
    const cfg = JSON.parse(read(cfgPath));
    cfgState = 'JSON 合法';
    const servers = cfg?.mcp?.servers ?? {};
    if (servers['download-service']) registeredAs = 'download-service';
    else if (servers['file-share']) registeredAs = 'file-share（旧名，建议改为 download-service）';
  } catch (e) {
    cfgState = fs.existsSync(cfgPath) ? `读取失败：${e.message}` : '文件不存在（尚未注册）';
  }

  const idx = store.load();
  const live = idx.filter((u) => {
    const e = store.expiryOf(u);
    return e ? e.getTime() > Date.now() : !u.retentionHours;
  });

  // ---- local service
  const {
    port, bind, storage, password, publicBase, upload, uploadMaxMb,
    uploadDailyMb, uploadDailyCount,
  } = loadConfig();
  const svcPid = Number(read(path.join(ROOT, 'service', 'service.pid')).trim()) || null;
  let health = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) health = await r.json();
  } catch {}
  const svcLine = health
    ? `运行中（PID ${svcPid ?? '?'}），已发布 ${health.files} 个文件`
    : `未运行（用 local 后端上传会自动拉起）`;

  // ---- frp tunnel
  const FRP = path.join(ROOT, 'frp');
  const frpConf = read(path.join(FRP, 'frpc.toml'));
  const frpBase = read(path.join(FRP, 'public-base.txt')).trim();
  const frpPid = Number(read(path.join(FRP, 'frpc.pid')).trim()) || null;
  const frpConfigured = frpConf && !/CHANGE_ME/.test(frpConf);
  const frpLine = !frpConf
    ? '未安装'
    : !frpConfigured
      ? '已安装但未配置（frp/frpc.toml 仍是 CHANGE_ME，说明没有 frps 服务方）'
      : alive(frpPid)
        ? `已连接（PID ${frpPid}）${frpBase ? `，对外 ${frpBase}` : ''}`
        : '已配置但未运行（node frp/manage.mjs up <公网地址>）';

  const chinese = '下载服务';

  return `# ${chinese} 运行状态与维护手册

本 MCP 的名字是“${chinese}”（技术标识符 \`download-service\`）。作用：把本机文件
发布成下载链接，并提供一张可浏览的文件列表页。

为什么不直接叫中文名：MCP 规范要求工具名匹配 \`^[a-zA-Z0-9_-]{1,64}$\`，客户端会把服务器名
拼进工具名（\`mcp__<服务器名>__<工具名>\`）。ZCode 的 normalizeMcpServerNameKey 只做
trim + toLowerCase，不过滤非 ASCII，所以中文服务器名会产出 \`mcp__下载服务__share_upload\`
这种不合规的工具名，有被拒风险。因此用 ASCII 标识符加中文显示名。

## 程序架构

\`\`\`
ZCode（会话/模型）
  └─ MCP 服务器“${chinese}” stdio，按需拉起，无常驻进程
       ${path.join(ROOT, 'server.mjs')}
       工具：share_upload / share_list / share_verify / share_doctor
       后端（可插拔，backends/*.mjs）：
         local      → 本机只读 HTTP 服务（默认用于长期链接）
         filekiwi   → file.kiwi 第三方托管，90 小时后失效
       状态：${store.INDEX_FILE}
                    │ 发布 = 把文件硬链接进 service/storage/<id>/
                    ▼
   本机下载服务（常驻，detached）
       service/server.mjs        HTTP ${port} on ${bind}
         GET  /                  密码门 + 文件列表（按发布时间倒序）+ 上传控件
         POST /login             校验密码 → 会话 Cookie
         POST /upload            网页上传（受 upload 模式与权限限制）
         GET  /logout
         GET  /s/<8位短码>       短链接下载（支持 Range 断点续传）
         GET  /f/<id>/<token>    早期长链接，保留兼容
         GET  /healthz
         写入仅限 /login 与 /upload 两个路径，其余非 GET/HEAD 一律 405
       service/shortcode.mjs    短码生成（网页上传与 MCP 共用同一实现，避免撞码）
       service/manage.mjs       start / stop / restart / status（PID 文件）
       service/config.mjs       解析 port / bind / publicBase / password
       service/config.json      部署配置（唯一需要手改的文件）
       service/storage/<id>/    实体文件（硬链接）+ meta.json
                    │ 可选
                    ▼
   frp 内网穿透（已下载，未启用）
       frp/frpc.exe v0.71.0（已对照官方 SHA256 校验）
       frp/frpc.toml + frp/manage.mjs
\`\`\`

设计要点：

- 上传入口原则上只存在于本机。MCP 工具只接受本地文件路径；网页上传默认
  \`upload: local\`，非本机来源一律拒绝。把 \`upload\` 改成 \`session\` 会打破这个性质，
  那时任何猜到密码的人都能写文件，改之前请先看下面的安全边界。
- 写入路径只有 /login 与 /upload 两条，且 /upload 自带权限判断（模式、登录、本机来源），
  不存在删除或改名接口。
- 发布用硬链接（同卷不额外占空间），跨卷自动退回复制。网页上传直接流式落盘。
- 链接有两代：8 位短码 \`/s/<code>\`（现在生成这个）和 \`/f/<id>/<token>\`（旧的仍可用）。

## 运行环境

- Node：${process.version}｜平台：${process.platform} ${process.arch}
- 工程目录：${ROOT}
- MCP 单文件上限：${maxMb} MB（环境变量 FILE_SHARE_MAX_MB，只约束 MCP 这条路径）
- 后端：${Object.keys(backends).join(' / ')}（默认 ${defaultBackend}）
- 记录数：${idx.length} 条，其中 ${live.length} 条仍有效

## 部署现状

- 监听：\`${bind}:${port}\`${bind === '0.0.0.0' ? '（所有网卡）' : '（仅本机）'}
- 局域网地址：http://${lanAddress()}:${port}
- 对外地址（写进链接的）：${publicBase}
- 首页密码：${password ? `已设置（长度 ${String(password).length}）` : '未设置，文件列表整体禁用（返回 403）'}
- 网页上传模式：${upload}（\`off\` 只读 / \`local\` 仅本机 / \`session\` 登录后任意来源），单文件上限 ${uploadMaxMb} MB
- 每日上传额度：${uploadDailyMb} MB / ${uploadDailyCount} 个文件（计数落在 \`<存储目录>/.upload-quota.json\`，按 UTC 日期，次日重置）
  ${upload === 'session' ? '当前任何登录成功的人都能写入，密码是唯一防线，建议尽快换成强密码。' : ''}
  ${upload === 'local' ? '（保持“仅限本机上传”的原始约束）' : ''}
- 开机自启任务：${autostartStatus()}
  安装 / 卸载：
  \`powershell -ExecutionPolicy Bypass -File "${path.join(ROOT, 'service', 'autostart.ps1')}"\`
  \`powershell -ExecutionPolicy Bypass -File "${path.join(ROOT, 'service', 'autostart.ps1')}" -Remove\`
  任务名 \`${AUTOSTART_TASK}\`，触发“登录时 + 延迟 20 秒”，失败自动重试 3 次。
  注意这是登录时启动，不是开机即启动。机器重启后如果没人登录，服务仍然不会运行。
- 本机防火墙：需要入站放行规则
  规则名 \`file-share download service (TCP ${port})\`
  检查：\`powershell -c "Get-NetFirewallRule -DisplayName 'file-share download service (TCP ${port})'"\`
  删除：\`powershell -c "Remove-NetFirewallRule -DisplayName 'file-share download service (TCP ${port})'"\`
- 这台机器不在家用路由器后面：网卡只有一个静态私网地址（当前 ${lanAddress()}），
  网卡名由服务商指定，出口公网 IP 由运营商或 NAT 提供。开放端口要在服务商控制台做，不是家里路由器。
- 外部可达性请用第三方探测，不要用本机 curl 公网 IP（NAT 回环通常不支持，会误判）：
  \`\`\`bash
  curl -s -X POST https://portchecker.io/api/v1/query -H "Content-Type: application/json" \\
    -d '{"host":"<公网IP>","ports":["${port}"]}'
  \`\`\`
  返回 \`"status":true\` 即为外部可达。

## ZCode 注册状态

- 配置文件：${cfgPath}
- 文件状态：${cfgState}
- 注册名：${registeredAs}

## 本机下载服务

- 状态：${svcLine}
- 存储目录：${storage}
- 日志：${path.join(ROOT, 'service', 'service.log')}（前缀 \`[local-share]\`）
- 命令：
  node "${path.join(ROOT, 'service', 'manage.mjs')}" start|stop|restart|status

## frp 隧道（可选，用于替代服务商端口开放）

- 状态：${frpLine}
- 配置：${path.join(FRP, 'frpc.toml')}｜日志 \`frp/frpc.log\`
- 命令：node "${path.join(FRP, 'manage.mjs')}" up <公网地址> | set-base | status | down
- 改配置后必须校验：\`frpc.exe verify -c frpc.toml\`
  \`transport.useEncryption\` / \`useCompression\` 是代理级字段（写在 \`[[proxies]]\` 内），
  写到全局会报 \`unknown field\`。
- 安全提醒：frp 的 TLS 是逐跳的（frpc↔frps），frps 那端持有密钥，能读取也能篡改
  所有流量。用公共 frps 等于把文件内容交给那个运营者。自己跑 frps（VPS）或做端到端加密才安全。
- 已知坑：Windows Defender 会拦 \`frps.exe\`（服务端，常见误报），\`frpc.exe\` 不受影响。
  给杀软加排除项属于削弱防护，必须先征得用户同意。

## 两个后端的取舍

| 后端 | 链接 | 有效期 | 适合 |
|---|---|---|---|
| local（用于长期分享） | \`<对外地址>/s/<短码>\` | 不过期，但依赖本机服务在线 | 自己反复下载、长期链接 |
| filekiwi | \`https://file.kiwi/xxx#key\` | 90 小时后失效 | 本机不必在线、发给任何人 |

## 四个工具

| 工具 | 用途 |
|---|---|
| share_upload | \`path\` 必填；可选 \`title\` / \`backend\` / \`background\`。返回短链接、记录 ID、有效期 |
| share_list | 上传历史（含剩余有效期）与进行中的任务 |
| share_verify | 校验文件在服务端是否仍在、是否完整 |
| share_doctor | 就是本报告 |

## 常用维护操作

改端口 / 绑定 / 对外地址 / 密码 → 编辑 \`service/config.json\` 后 \`node service/manage.mjs restart\`：

\`\`\`json
{ "port": ${port}, "bind": "${bind}", "publicBase": "${publicBase}", "storage": "",
  "password": "CHANGE_ME", "upload": "${upload}", "uploadMaxMb": ${uploadMaxMb} }
\`\`\`

- \`upload\` 三档：\`off\` 只读 / \`local\` 仅本机（默认）/ \`session\` 登录后任意来源。
  改它等于改变暴露面，改前先看安全边界那一节。
- \`uploadMaxMb\` 单文件上限，边写边判，超限立即中止并删除半截文件。

- \`publicBase\` 决定链接里用哪个地址；留空则自动用局域网 IP。
  公网 IP 若会变，建议填 DDNS 域名，否则 IP 一变已发链接全失效。
- 环境变量 \`FILE_SHARE_PORT\` / \`FILE_SHARE_BIND\` / \`FILE_SHARE_PUBLIC_BASE\` / \`FILE_SHARE_PASSWORD\`
  优先级高于配置文件。
- 撤销某个分享：删掉 \`service/storage/<id>/\` 目录，链接立刻失效。
- 全量自检：\`node tools/selftest.mjs\`（真实走 JSON-RPC 协议）；
  附加真实上传：\`node tools/selftest.mjs --upload <文件> --backend local\`。
- 改代码或依赖后：重启 ZCode 会话，在 Settings → MCP 里确认 \`download-service\` 为 connected。

## 安全边界

- 明文 HTTP，没有 TLS。路径上的运营商与中间节点能看到文件内容和登录 Cookie。
- 短链接的 8 位短码是下载的唯一访问控制（约 47 位熵）。谁拿到链接谁就能下载。
- 文件列表页公网可访问，只靠密码挡着。密码若很短（如三位数字），列表实际接近公开，
  而列表会显示每个文件的完整链接，密码被猜中即等于全部文件泄露。
  登录失败有限流（同 IP 10 分钟 8 次），超限后跳到 \`/?e=slow\`。
  实现上是先校验密码、只对失败计次，所以限流永远不会挡住正确密码，
  用户不会因为别人（或自己）的失败尝试被锁在门外。它只能拖慢定向枚举，挡不住弱密码本身。
- 服务默认只读（\`upload: local\` 时外部无法写入）；改成 \`session\` 后外部可写入。
- 把 \`upload\` 设为 \`session\` 是这套东西里风险最高的一个开关：
  - 三位数的密码穷举是瞬间的事，等于把写入权公开。扫描器会主动找这种开放上传点。
  - 后果是磁盘被塞满、被用来托管违法内容，而责任落在这台机器的所有者身上。
  - 若确需远程上传，请先把密码换成强密码，并接受被滥用的风险。
  - 上传的文件默认会出现在列表页并生成短链接，即对外可下载。
- 上传的文件以 \`Content-Disposition: attachment\` 下发，浏览器不会内联渲染，
  因此不能被当作钓鱼或挂马页面使用，这是刻意的。
- 不要放敏感文件（证件、密钥、财务、私人照片）。适合传书、安装包、公开资料。
- 登录态是两个无状态 HMAC 签名 cookie，没有用内存会话，因为服务会重启，内存会让长有效期失去意义：
  - \`fs_session\` 30 天，滑动续期：每次已认证访问都重新计时，日常门禁靠它。
  - \`fs_remember\` 180 天，只在显式登录时续期：短 cookie 失效后凭它静默补发新的短 cookie，
    所以最长可保持半年不用重新输密码；重新登录会把半年重新起算。
  - 两者都是 \`HttpOnly; SameSite=Lax\`。因为服务是纯 HTTP，无法加 \`Secure\`，路径上可被截获。
  - 签名密钥在 \`service/cookie-secret.txt\`（首次启动自动生成，权限仅限管理员）。
    删掉这个文件即可一次性作废所有已发出的令牌，所有人都要重新登录。
  - “退出”只清当前浏览器的两个 cookie；无状态令牌无法单点吊销，要全吊销就删密钥文件。

## 故障处理

| 症状 | 原因 | 处理 |
|---|---|---|
| Settings → MCP 里没有 download-service | 配置 JSON 语法错误，或含未知键被严格 schema 丢弃 | 校验 ${cfgPath}；只用 type/command/args/cwd/env/enabled/timeoutMs |
| 状态 failed，报 spawn ENOENT | command 指向的可执行文件不存在 | 确认 \`C:\\\\Program Files\\\\nodejs\\\\node.exe\` 还在 |
| 工具调用超时 | 上传超过 timeoutMs | 已设 900000（15 分钟）；超大文件用 \`background: true\` |
| 外部打不开首页 | 服务商侧端口未放行，或本机防火墙未放行 | 用上面的 portchecker 探测；检查防火墙规则 |
| 首页返回 403 | config.json 里 password 为空 | 设置一个密码后重启 |
| 短链接 404 | 短码错、或文件已从 storage 删除 | share_verify 确认；必要时重新发布 |
| 登录总返回 401 | 密码不对 | 查 config.json 的 password |
| 登录后跳到 /?e=slow | 触发了失败限流（只计失败，正确密码不受影响） | 等 10 分钟，或重启服务清空计数 |
| 刷新页面提示“重新提交表单” | 登录流程被改成了 POST 直接返回 HTML | 必须保持 POST/Redirect/GET：成功与失败都返回 302 |
| local 上传报端口占用 | ${port} 被别的程序占用 | 改 config.json 的 port |
| 网页上传返回 403 | 模式不允许 / 未登录 / 非本机来源 | 看响应正文，它会说明是哪种原因；改 config.json 的 upload |
| 网页上传返回 413 | 超过单文件上限，或加上今日用量会超当日额度 | 看响应正文区分；改 uploadMaxMb / uploadDailyMb 后重启 |
| 网页上传返回 429 | 当日额度已用完 | 次日自动重置；或调大 uploadDailyMb / uploadDailyCount |
| 网页上传返回 400 | 上传了空文件 | 正常拦截，换有内容的文件 |
| 列表页没有上传控件 | 当前请求不允许上传 | 属于预期行为：拒绝时不展示上传入口，避免对外暴露这个能力 |`;
}
