import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function assertLocalUrl(value, label) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error(`${label}必须是本机 HTTP 地址`);
  }
  return parsed;
}

function receiveOnlyConfig(archiveUrl) {
  return {
    network: {
      httpServers: [],
      httpClients: [
        {
          name: 'lockmyitem-archive-receive-only',
          enable: true,
          url: archiveUrl,
          messagePostFormat: 'array',
          reportSelfMessage: false,
          token: '',
          debug: false
        }
      ],
      httpSseServers: [],
      websocketServers: [],
      websocketClients: [],
      plugins: []
    },
    musicSignUrl: '',
    enableLocalFile2Url: false,
    parseMultMsg: false
  };
}

async function post(baseUrl, endpoint, payload, credential = '') {
  const response = await fetch(new URL(`/api${endpoint}`, baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(credential ? { authorization: `Bearer ${credential}` } : {})
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok || body.code !== 0) {
    throw new Error(`${endpoint} 失败：${body.message || response.status}`);
  }
  return body.data;
}

const shellRootArgument = argument('--shell-root');
if (!shellRootArgument) throw new Error('必须提供 --shell-root NapCat 绿色运行目录');

const shellRoot = path.resolve(shellRootArgument);
const archiveUrl = assertLocalUrl(
  argument('--archive-url', 'http://127.0.0.1:8788/onebot/events'),
  '归档上报地址'
).href;
const webUiUrl = assertLocalUrl(
  argument('--webui-url', 'http://127.0.0.1:6099'),
  'NapCat WebUI 地址'
);
const timeoutSeconds = positiveInteger(argument('--timeout-seconds', '600'), 600);
const intervalMs = positiveInteger(argument('--interval-ms', '1000'), 1000);

const versionsDirectory = path.join(shellRoot, 'versions');
const version = (await fs.readdir(versionsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
if (!version) throw new Error(`未在 ${versionsDirectory} 找到 QQ 版本目录`);

const napcatRoot = path.join(
  versionsDirectory,
  version,
  'resources',
  'app',
  'napcat'
);
const configDirectory = path.join(napcatRoot, 'config');
const webUiConfig = JSON.parse(
  await fs.readFile(path.join(configDirectory, 'webui.json'), 'utf8')
);
if (!webUiConfig.token) throw new Error('NapCat WebUI token 为空');

const hash = crypto
  .createHash('sha256')
  .update(`${webUiConfig.token}.napcat`)
  .digest('hex');
const login = await post(webUiUrl, '/auth/login', { hash });
const credential = login?.Credential || login?.token || login;
if (typeof credential !== 'string' || !credential) {
  throw new Error('NapCat WebUI 没有返回会话凭据');
}

const deadline = Date.now() + timeoutSeconds * 1000;
let loginStatus;
while (Date.now() < deadline) {
  loginStatus = await post(webUiUrl, '/QQLogin/CheckLoginStatus', {}, credential);
  if (loginStatus?.isLogin) break;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
if (!loginStatus?.isLogin) {
  throw new Error(`等待 QQ 登录超时（${timeoutSeconds} 秒）`);
}

const loginInfo = await post(webUiUrl, '/QQLogin/GetQQLoginInfo', {}, credential);
const uin = String(loginInfo?.uin || '');
if (!/^\d+$/.test(uin)) throw new Error('登录成功但没有取得有效 QQ 号');

const oneBotConfig = receiveOnlyConfig(archiveUrl);
await post(
  webUiUrl,
  '/OB11Config/SetConfig',
  { config: JSON.stringify(oneBotConfig) },
  credential
);
await Promise.all([
  fs.writeFile(
    path.join(configDirectory, 'onebot11.json'),
    `${JSON.stringify(oneBotConfig, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  ),
  fs.writeFile(
    path.join(configDirectory, `onebot11_${uin}.json`),
    `${JSON.stringify(oneBotConfig, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
]);

process.stdout.write(`${JSON.stringify({
  configured: true,
  logged_in: true,
  uin,
  qq_version: version,
  archive_url: archiveUrl,
  receive_only: true,
  report_self_message: false,
  config_files: [
    path.join(configDirectory, 'onebot11.json'),
    path.join(configDirectory, `onebot11_${uin}.json`)
  ]
}, null, 2)}\n`);
