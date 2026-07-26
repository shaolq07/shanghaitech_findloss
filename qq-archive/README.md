# QQ 群未来消息归档

这个服务只处理启动之后由 QQ Bot 上报的新消息，不读取 QQ 客户端数据库、聊天缓存或用户目录。默认先可靠写入仓库内的 `QQ聊天记录/`，配置 CloudBase 后会异步上传云端审核队列；只有管理员审核通过的记录才会出现在官网。

当前接收标准 OneBot 11 群消息事件，适用于能把群事件通过 HTTP POST 上报的 NapCat、Lagrange.Core、go-cqhttp 兼容实现。普通 QQ 客户端不会自行产生 OneBot 事件，仍需在 Bot 侧配置一次上报地址。

## 数据位置

- 消息：`QQ聊天记录/exports/group-群号.jsonl`
- 新图片：`QQ聊天记录/archive-media/群号/YYYY-MM-DD/`
- 现有图片清单：`QQ聊天记录/existing-media.jsonl`
- 现有图片人工分组：`QQ聊天记录/media-catalog.json`
- 单实例锁：`QQ聊天记录/.qq-archive.lock`

每条 JSONL 消息包含群号、消息号、时间、发送者、文本、标准化消息段、图片本地路径，以及基于聊天文字得到的 `lost_found.type`（`lost`、`found` 或 `unknown`）。同一 `group_id + message_id` 只保存一次。

## 启动

PowerShell：

```powershell
cd qq-archive
$env:QQ_ARCHIVE_WEBHOOK_TOKEN = '换成一段随机长字符串'
$env:QQ_ARCHIVE_GROUP_IDS = '123456'
npm start
```

默认监听 `http://127.0.0.1:8788`。如果 Bot 和本服务不在同一台机器，可设置 `QQ_ARCHIVE_HOST=0.0.0.0`，但此时必须配置 `QQ_ARCHIVE_WEBHOOK_TOKEN`，并只在受控网络中开放端口。

Windows 也可使用带重复进程检查的启动脚本：

```powershell
.\scripts\start-windows.ps1 `
  -GroupIds '123456' `
  -WebhookToken '换成一段随机长字符串'
```

如果归档器已经运行，脚本会返回现有 PID，不再启动第二个进程；如果端口被其他服务占用则直接报错。Token 仅传给子进程，不写入配置文件。

本仓库当前使用已验证兼容的 NapCat v4.18.13 与 QQ
9.9.31-49738 隔离运行时。先启动归档器，再启动 NapCat：

```powershell
.\scripts\start-windows.ps1 -GroupIds '731332881'
.\scripts\start-napcat-windows.ps1
```

NapCat 启动脚本会复用已有实例，显式传入 QQ 与注入模块路径，并在检测到普通
QQ 主进程或 6099 端口冲突时停止启动。它不会调用任何 OneBot 消息发送接口。

扫码登录前可以再启动一次登录监视器。它等待隔离 QQ 会话真正显示登录成功，
随后把相同的“只接收”配置同时写入默认配置和当前 QQ 账号配置，避免出现网页
看似登录但账号专属 OneBot 配置没有启用的情况：

```powershell
npm run watch:napcat-login -- `
  --shell-root '..\_runtime\napcat\NapCat.49738.Shell'
```

监视器只调用 WebUI 的登录状态、登录信息和 `OB11Config/SetConfig`，不会调用
任何发送消息接口。默认最多等待 10 分钟。

## Bot 侧设置

在 OneBot 实现的“HTTP 事件上报 / HTTP Client / 反向 HTTP”设置中填写：

```text
http://127.0.0.1:8788/onebot/events
```

Access Token / Secret 与 `QQ_ARCHIVE_WEBHOOK_TOKEN` 保持一致。服务接受 Bearer Token、`X-Archive-Token`，也兼容 OneBot 反向 HTTP 常用的 `X-Signature: sha1=...` HMAC 签名：

```text
Authorization: Bearer 你的Token
X-Archive-Token: 你的Token
```

可选环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `QQ_ARCHIVE_ROOT` | 仓库内 `QQ聊天记录` | 归档根目录 |
| `QQ_ARCHIVE_HOST` | `127.0.0.1` | 监听地址 |
| `QQ_ARCHIVE_PORT` | `8788` | 监听端口 |
| `QQ_ARCHIVE_GROUP_IDS` | 空 | 逗号分隔的群号白名单；空表示所有群 |
| `QQ_ARCHIVE_MAX_BODY_BYTES` | `5242880` | 单事件最大字节数 |
| `QQ_ARCHIVE_MAX_IMAGE_BYTES` | `12582912` | 单图片最大字节数 |
| `QQ_ARCHIVE_IMAGE_TIMEOUT_MS` | `15000` | 图片下载超时 |
| `QQ_CLOUD_INGEST_URL` | 空 | CloudBase HTTP 访问服务的 HTTPS 地址 |
| `QQ_CLOUD_INGEST_TOKEN` | 空 | 与云函数 `QQ_INGEST_TOKEN` 一致的高强度密钥 |
| `QQ_CLOUD_GROUP_IDS` | `731332881` | 允许上传云端的群号；与本地归档白名单分开 |
| `QQ_CLOUD_RETRY_MS` | `30000` | 云端失败任务的重试间隔 |
| `QQ_CLOUD_TIMEOUT_MS` | `45000` | 云端上传超时 |
| `QQ_CLOUD_MAX_IMAGE_BYTES` | `8388608` | 单张云端图片上限 |

云端转发启用后，待发送任务位于 `QQ聊天记录/cloud-outbox/`。上传成功后任务文件自动删除；断网或云端暂不可用时会保留并持续重试。生产群固定为 `731332881`：

```powershell
$env:QQ_CLOUD_INGEST_URL = 'https://你的CloudBase默认域名/qq-ingest'
$env:QQ_CLOUD_INGEST_TOKEN = '与云函数一致的随机长密钥'
$env:QQ_CLOUD_GROUP_IDS = '731332881'
npm start
```

不要把真实密钥写入仓库或 NapCat 配置。NapCat 仍只向本机归档器上报，云端密钥只由归档器进程持有。

归档器只下载事件中给出的 HTTPS 图片 URL。若图片段的 `file` 与 `QQ聊天记录/` 顶层现有图片同名（或主文件名相同），会直接建立对应关系，不重复下载，也不会访问 QQ 的系统文件。

`media-catalog.json` 已把肉眼可确认属于同一物品的多张照片归为一组。由于当前 `QQ.txt` 是空文件，旧图的 `lost_found_type` 保持 `unknown`；含姓名、人像或学号风险的图片标记为禁止直接公开，接入官网前需要脱敏。

## 检查与查询

```powershell
Invoke-RestMethod http://127.0.0.1:8788/health
Invoke-RestMethod `
  -Headers @{ Authorization = 'Bearer 你的Token' } `
  'http://127.0.0.1:8788/messages?group_id=123456&limit=20'
```

重新生成现有图片清单：

```powershell
npm run index:existing
```

运行自动测试：

```powershell
npm test
```

## MCP 查询

归档写入服务与 MCP 查询服务是两个独立进程。MCP 进程只读 `exports/*.jsonl` 和图片清单，不获取 `.qq-archive.lock`，因此可以在监听器持续写入时查询，不会产生两个归档任务争抢文件的问题。

可用工具：

- `qq_archive_list_groups`
- `qq_archive_search_messages`
- `qq_archive_get_message`
- `qq_archive_list_media`

配置样例见 `qq-archive/mcp.example.json`。MCP 客户端需要以 stdio 方式运行：

```powershell
npm run mcp
```
