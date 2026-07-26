import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { promisify } from 'node:util';
import { ArchiveReader } from '../src/archive-reader.mjs';
import { ArchiveStore } from '../src/archive-store.mjs';
import { classifyLostFound, normalizeOneBotEvent, parseCqMessage } from '../src/normalize.mjs';
import { acquireProcessLock } from '../src/process-lock.mjs';

const execFileAsync = promisify(execFile);

function makeConfig(archiveRoot) {
  return {
    archiveRoot,
    allowedGroupIds: new Set(['123456']),
    maxImageBytes: 1024 * 1024,
    imageTimeoutMs: 1000
  };
}

function event(overrides = {}) {
  return {
    time: 1784865600,
    post_type: 'message',
    message_type: 'group',
    group_id: 123456,
    message_id: 'abc',
    user_id: 987654,
    sender: { card: '张三', nickname: '昵称' },
    message: [{ type: 'text', data: { text: '我在图书馆捡到一把伞，谁的？' } }],
    ...overrides
  };
}

test('解析 CQ 文本和图片段', () => {
  assert.deepEqual(parseCqMessage('看看[CQ:image,file=ABC.jpg,url=https://example.com/a.jpg]'), [
    { type: 'text', data: { text: '看看' } },
    { type: 'image', data: { file: 'ABC.jpg', url: 'https://example.com/a.jpg' } }
  ]);
});

test('按聊天文字区分寻物和发现', () => {
  assert.equal(classifyLostFound('我的黑色雨伞丢了，有人看到吗？').type, 'lost');
  assert.equal(classifyLostFound('在二号食堂捡到校园卡，谁的？').type, 'found');
  assert.equal(classifyLostFound('今天会议几点？').type, 'unknown');
});

test('规范化 OneBot 群消息', () => {
  const normalized = normalizeOneBotEvent(event());
  assert.equal(normalized.group_id, '123456');
  assert.equal(normalized.sender_name, '张三');
  assert.equal(normalized.message_type, 'text');
  assert.equal(normalized.lost_found.type, 'found');
  assert.match(normalized.time, /\+08:00$/);
});

test('消息持久化、现有图片对应及跨并发去重', async (context) => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-archive-'));
  context.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(archiveRoot, 'ABC.jpg'), Buffer.from('existing-image'));

  const store = new ArchiveStore(makeConfig(archiveRoot), {
    downloadImage: async () => {
      throw new Error('已有图片不应再次下载');
    }
  });
  await store.init();

  const imageEvent = event({
    message: [
      { type: 'text', data: { text: '捡到一张卡' } },
      { type: 'image', data: { file: 'ABC.jpg', url: 'https://example.com/a.jpg' } }
    ]
  });
  const [first, second] = await Promise.all([store.ingest(imageEvent), store.ingest(imageEvent)]);
  assert.equal(first.archived, true);
  assert.equal(second.duplicate, true);

  const messages = await store.query({ groupId: '123456' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].images[0].source, 'existing');
  assert.equal(messages[0].images[0].relative_path, 'ABC.jpg');

  const mediaIndex = (await fs.readFile(path.join(archiveRoot, 'existing-media.jsonl'), 'utf8'))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(mediaIndex[0].linked_group_id, '123456');
  assert.equal(mediaIndex[0].linked_message_id, 'abc');
  assert.equal(mediaIndex[0].lost_found_type, 'found');
  assert.deepEqual(mediaIndex[0].message_links.map((link) => link.message_id), ['abc']);
});

test('进程锁阻止两个归档实例同时写同一目录', async (context) => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-archive-lock-'));
  context.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
  const first = await acquireProcessLock(archiveRoot);
  context.after(() => first.release());
  await assert.rejects(() => acquireProcessLock(archiveRoot), /已在运行/);
  await first.release();
  const second = await acquireProcessLock(archiveRoot);
  await second.release();
});

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`归档服务提前退出：${child.exitCode}`);
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // 服务仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待归档服务启动超时');
}

test('HTTP 服务接收、查询并去重真实 OneBot 事件', async (context) => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-archive-http-'));
  const port = await availablePort();
  const token = 'integration-secret';
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      QQ_ARCHIVE_ROOT: archiveRoot,
      QQ_ARCHIVE_PORT: String(port),
      QQ_ARCHIVE_WEBHOOK_TOKEN: token,
      QQ_ARCHIVE_GROUP_IDS: '123456'
    }
  });
  context.after(async () => {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);
  const initialHealth = await (await fetch(`${baseUrl}/health`)).json();
  assert.equal(initialHealth.events.received, 0);
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
  const body = JSON.stringify(event({ message_id: 'http-1' }));

  const first = await fetch(`${baseUrl}/onebot/events`, { method: 'POST', headers, body });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).archived, true);

  const duplicate = await fetch(`${baseUrl}/onebot/events`, { method: 'POST', headers, body });
  assert.equal((await duplicate.json()).duplicate, true);

  const ignored = await fetch(`${baseUrl}/onebot/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' })
  });
  assert.equal((await ignored.json()).ignored, true);

  const query = await fetch(`${baseUrl}/messages?group_id=123456&limit=10`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const queryBody = await query.json();
  assert.equal(queryBody.count, 1);
  assert.equal(queryBody.messages[0].message_id, 'http-1');
  assert.equal(queryBody.messages[0].lost_found.type, 'found');

  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.deepEqual(health.events, {
    received: 3,
    archived: 1,
    duplicates: 1,
    ignored: 1,
    last_event_at: health.events.last_event_at,
    last_archive_at: health.events.last_archive_at
  });
  assert.match(health.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(health.events.last_event_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(health.events.last_archive_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('现有 QQ 图片人工清单覆盖全部图片且不重复', async () => {
  const workspaceRoot = path.resolve(import.meta.dirname, '..', '..');
  const qqDirectory = path.join(workspaceRoot, 'QQ聊天记录');
  const catalog = JSON.parse(await fs.readFile(path.join(qqDirectory, 'media-catalog.json'), 'utf8'));
  const catalogFiles = catalog.items.flatMap((item) => item.files);
  const actualFiles = (await fs.readdir(qqDirectory))
    .filter((name) => /\.(?:jpe?g|png|gif|webp|bmp)$/i.test(name))
    .sort();

  assert.deepEqual([...catalogFiles].sort(), actualFiles);
  assert.equal(new Set(catalogFiles).size, catalogFiles.length);
  assert.equal(
    catalog.items.find((item) => item.catalog_id === 'qq-existing-campus-card').web_publish_allowed,
    false
  );
});

test('只读查询器支持群、关键词、分类和时间筛选', async (context) => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-archive-reader-'));
  context.after(() => fs.rm(archiveRoot, { recursive: true, force: true }));
  const exportsDirectory = path.join(archiveRoot, 'exports');
  await fs.mkdir(exportsDirectory, { recursive: true });
  const messages = [
    {
      group_id: '123456',
      message_id: 'reader-1',
      time: '2026-07-24T12:00:00+08:00',
      sender_id: '10001',
      sender_name: '张三',
      content: '我在图书馆丢了一把黑色雨伞',
      lost_found: { type: 'lost' },
      images: []
    },
    {
      group_id: '123456',
      message_id: 'reader-2',
      time: '2026-07-25T12:00:00+08:00',
      sender_id: '10002',
      sender_name: '李四',
      content: '在食堂捡到校园卡',
      lost_found: { type: 'found' },
      images: [{ original_file: 'CARD.jpg' }]
    }
  ];
  await fs.writeFile(
    path.join(exportsDirectory, 'group-123456.jsonl'),
    `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    'utf8'
  );

  const reader = new ArchiveReader(archiveRoot);
  const groups = await reader.listGroups();
  assert.equal(groups[0].message_count, 2);
  assert.equal(groups[0].image_message_count, 1);

  const found = await reader.searchMessages({
    group_id: '123456',
    lost_found_type: 'found',
    query: 'card.jpg'
  });
  assert.deepEqual(found.map((message) => message.message_id), ['reader-2']);

  const earlier = await reader.searchMessages({ until: '2026-07-24T23:59:59+08:00' });
  assert.deepEqual(earlier.map((message) => message.message_id), ['reader-1']);
  assert.equal((await reader.getMessage('123456', 'reader-2')).sender_name, '李四');
});

function sendMcpRequest(child, output, request) {
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      cleanup();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`MCP 服务提前退出：${code}`));
    };
    const cleanup = () => {
      output.off('line', onLine);
      child.off('exit', onExit);
    };
    output.once('line', onLine);
    child.once('exit', onExit);
    child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

test('MCP stdio 服务暴露归档查询工具且不获取写入锁', async (context) => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-archive-mcp-'));
  await fs.mkdir(path.join(archiveRoot, 'exports'), { recursive: true });
  await fs.writeFile(
    path.join(archiveRoot, 'exports', 'group-123456.jsonl'),
    `${JSON.stringify({
      group_id: '123456',
      message_id: 'mcp-1',
      time: '2026-07-25T12:00:00+08:00',
      sender_id: '10001',
      sender_name: '张三',
      content: '捡到一把雨伞',
      lost_found: { type: 'found' },
      images: []
    })}\n`,
    'utf8'
  );

  const writeLock = await acquireProcessLock(archiveRoot);
  const child = spawn(process.execPath, ['src/mcp-server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, QQ_ARCHIVE_ROOT: archiveRoot }
  });
  const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  context.after(async () => {
    output.close();
    child.kill();
    await writeLock.release();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  const initialized = await sendMcpRequest(child, output, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } }
  });
  assert.equal(initialized.result.serverInfo.name, 'lockmyitem-qq-archive');

  const listed = await sendMcpRequest(child, output, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    [
      'qq_archive_list_groups',
      'qq_archive_search_messages',
      'qq_archive_get_message',
      'qq_archive_list_media'
    ]
  );

  const called = await sendMcpRequest(child, output, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'qq_archive_search_messages',
      arguments: { group_id: '123456', query: '雨伞' }
    }
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.result[0].message_id, 'mcp-1');
});

test('NapCat 运行配置只启用接收事件客户端，不开放发送接口', async (context) => {
  const shellRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'napcat-receive-only-'));
  context.after(() => fs.rm(shellRoot, { recursive: true, force: true }));
  const napcatRoot = path.join(
    shellRoot,
    'versions',
    '9.9.99-99999',
    'resources',
    'app',
    'napcat'
  );
  await fs.mkdir(napcatRoot, { recursive: true });
  await fs.writeFile(path.join(napcatRoot, 'napcat.mjs'), '', 'utf8');

  await execFileAsync(process.execPath, [
    'scripts/configure-napcat-runtime.mjs',
    '--shell-root',
    shellRoot,
    '--archive-url',
    'http://127.0.0.1:8788/onebot/events'
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    windowsHide: true
  });

  const configDirectory = path.join(napcatRoot, 'config');
  const oneBot = JSON.parse(await fs.readFile(path.join(configDirectory, 'onebot11.json'), 'utf8'));
  const webUi = JSON.parse(await fs.readFile(path.join(configDirectory, 'webui.json'), 'utf8'));
  assert.equal(oneBot.network.httpServers.length, 0);
  assert.equal(oneBot.network.websocketServers.length, 0);
  assert.equal(oneBot.network.websocketClients.length, 0);
  assert.equal(oneBot.network.httpClients.length, 1);
  assert.equal(oneBot.network.httpClients[0].enable, true);
  assert.equal(oneBot.network.httpClients[0].reportSelfMessage, false);
  assert.equal(oneBot.network.httpClients[0].url, 'http://127.0.0.1:8788/onebot/events');
  assert.equal(webUi.host, '127.0.0.1');
  assert.ok(webUi.token.length >= 24);
});

test('登录监视器在真实登录后写入账号配置且只调用接收配置接口', async (context) => {
  const shellRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'napcat-login-watch-'));
  context.after(() => fs.rm(shellRoot, { recursive: true, force: true }));
  const napcatRoot = path.join(
    shellRoot,
    'versions',
    '9.9.99-99999',
    'resources',
    'app',
    'napcat'
  );
  const configDirectory = path.join(napcatRoot, 'config');
  await fs.mkdir(configDirectory, { recursive: true });
  await fs.writeFile(
    path.join(configDirectory, 'webui.json'),
    `${JSON.stringify({ token: 'test-webui-token' })}\n`,
    'utf8'
  );

  const calls = [];
  let configured = null;
  const api = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
      : {};
    calls.push({ path: request.url, body });

    const payload = request.url === '/api/auth/login'
      ? { Credential: 'test-session' }
      : request.url === '/api/QQLogin/CheckLoginStatus'
        ? { isLogin: true }
        : request.url === '/api/QQLogin/GetQQLoginInfo'
          ? { uin: '10001', nick: '归档测试' }
          : {};
    if (request.url === '/api/OB11Config/SetConfig') {
      configured = JSON.parse(body.config);
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: payload }));
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => api.close(resolve)));
  const address = api.address();

  await execFileAsync(process.execPath, [
    'scripts/watch-napcat-login.mjs',
    '--shell-root',
    shellRoot,
    '--webui-url',
    `http://127.0.0.1:${address.port}`,
    '--archive-url',
    'http://127.0.0.1:8788/onebot/events',
    '--timeout-seconds',
    '2',
    '--interval-ms',
    '10'
  ], {
    cwd: path.resolve(import.meta.dirname, '..'),
    windowsHide: true
  });

  assert.deepEqual(calls.map((call) => call.path), [
    '/api/auth/login',
    '/api/QQLogin/CheckLoginStatus',
    '/api/QQLogin/GetQQLoginInfo',
    '/api/OB11Config/SetConfig'
  ]);
  assert.equal(calls.some((call) => /send|message/i.test(call.path)), false);
  assert.equal(configured.network.httpServers.length, 0);
  assert.equal(configured.network.websocketServers.length, 0);
  assert.equal(configured.network.websocketClients.length, 0);
  assert.equal(configured.network.httpClients.length, 1);
  assert.equal(configured.network.httpClients[0].reportSelfMessage, false);
  assert.equal(
    configured.network.httpClients[0].url,
    'http://127.0.0.1:8788/onebot/events'
  );

  const accountConfig = JSON.parse(
    await fs.readFile(path.join(configDirectory, 'onebot11_10001.json'), 'utf8')
  );
  assert.deepEqual(accountConfig, configured);
});
