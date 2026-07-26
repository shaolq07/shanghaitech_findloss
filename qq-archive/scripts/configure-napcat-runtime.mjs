import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

const shellRootArgument = argument('--shell-root');
const archiveUrl = argument('--archive-url', 'http://127.0.0.1:8788/onebot/events');
if (!shellRootArgument) {
  throw new Error('必须提供 --shell-root NapCat绿色运行目录');
}

const shellRoot = path.resolve(shellRootArgument);
const versionsDirectory = path.join(shellRoot, 'versions');
const versions = (await fs.readdir(versionsDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
if (!versions.length) throw new Error(`未在 ${versionsDirectory} 找到 QQ 版本目录`);

const napcatRoot = path.join(
  versionsDirectory,
  versions[0],
  'resources',
  'app',
  'napcat'
);
const napcatEntry = path.join(napcatRoot, 'napcat.mjs');
await fs.access(napcatEntry);

const parsedArchiveUrl = new URL(archiveUrl);
if (parsedArchiveUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsedArchiveUrl.hostname)) {
  throw new Error('归档上报地址必须是本机 HTTP 地址');
}

const configDirectory = path.join(napcatRoot, 'config');
await fs.mkdir(configDirectory, { recursive: true });

const oneBotConfig = {
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
    websocketClients: []
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false
};

const webUiConfig = {
  host: '127.0.0.1',
  port: 6099,
  token: crypto.randomBytes(24).toString('base64url'),
  loginRate: 3
};

const napcatConfig = {
  fileLog: true,
  consoleLog: true,
  fileLogLevel: 'info',
  consoleLogLevel: 'info',
  packetServer: ''
};

await Promise.all([
  fs.writeFile(
    path.join(configDirectory, 'onebot11.json'),
    `${JSON.stringify(oneBotConfig, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  ),
  fs.writeFile(
    path.join(configDirectory, 'webui.json'),
    `${JSON.stringify(webUiConfig, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  ),
  fs.writeFile(
    path.join(configDirectory, 'napcat.json'),
    `${JSON.stringify(napcatConfig, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
]);

process.stdout.write(`${JSON.stringify({
  configured: true,
  shell_root: shellRoot,
  qq_version: versions[0],
  napcat_root: napcatRoot,
  archive_url: archiveUrl,
  receive_only: true,
  report_self_message: false,
  webui_host: webUiConfig.host,
  webui_port: webUiConfig.port
}, null, 2)}\n`);
