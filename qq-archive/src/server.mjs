import http from 'node:http';
import crypto from 'node:crypto';
import { ArchiveStore } from './archive-store.mjs';
import { loadConfig } from './config.mjs';
import { acquireProcessLock } from './process-lock.mjs';
import { CloudForwarder } from './cloud-forwarder.mjs';

function json(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorized(request, token, rawBody = null) {
  if (!token) return true;
  const authorization = request.headers.authorization || '';
  const headerToken = request.headers['x-archive-token'] || '';
  if (safeEqual(authorization, `Bearer ${token}`) || safeEqual(headerToken, token)) return true;
  const signature = request.headers['x-signature'] || '';
  if (!rawBody || !signature.startsWith('sha1=')) return false;
  const expected = `sha1=${crypto.createHmac('sha1', token).update(rawBody).digest('hex')}`;
  return safeEqual(signature, expected);
}

async function readJsonBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error('请求体过大');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const rawBody = Buffer.concat(chunks);
    return {
      rawBody,
      payload: JSON.parse(rawBody.toString('utf8'))
    };
  } catch {
    const error = new Error('请求体不是有效 JSON');
    error.statusCode = 400;
    throw error;
  }
}

const config = loadConfig();
const processLock = await acquireProcessLock(config.archiveRoot);
const store = new ArchiveStore(config);
await store.init();
const cloudForwarder = new CloudForwarder(config);
await cloudForwarder.init();
const startedAt = new Date();
const eventMetrics = {
  received: 0,
  archived: 0,
  duplicates: 0,
  ignored: 0,
  last_event_at: null,
  last_archive_at: null
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      return json(response, 200, {
        ok: true,
        service: 'lockmyitem-qq-archive',
        archive_root: config.archiveRoot,
        allowed_groups: [...config.allowedGroupIds],
        started_at: startedAt.toISOString(),
        events: { ...eventMetrics }
        ,
        cloud: cloudForwarder.getStats()
      });
    }

    if (request.method === 'GET' && requestUrl.pathname === '/messages') {
      if (!isAuthorized(request, config.webhookToken)) {
        return json(response, 401, { ok: false, error: '未授权' });
      }
      const messages = await store.query({
        groupId: requestUrl.searchParams.get('group_id') || '',
        limit: requestUrl.searchParams.get('limit') || '100'
      });
      return json(response, 200, { ok: true, count: messages.length, messages });
    }

    if (
      request.method === 'POST'
      && ['/onebot/events', '/webhook'].includes(requestUrl.pathname)
    ) {
      const { rawBody, payload } = await readJsonBody(request, config.maxBodyBytes);
      if (!isAuthorized(request, config.webhookToken, rawBody)) {
        return json(response, 401, { ok: false, error: '未授权' });
      }
      eventMetrics.received += 1;
      eventMetrics.last_event_at = new Date().toISOString();
      const result = await store.ingest(payload);
      if (result.archived) {
        eventMetrics.archived += 1;
        eventMetrics.last_archive_at = eventMetrics.last_event_at;
      } else if (result.duplicate) {
        eventMetrics.duplicates += 1;
      } else if (result.ignored) {
        eventMetrics.ignored += 1;
      }
      const cloud = result.archived
        ? await cloudForwarder.enqueue(result.record)
        : { queued: false };
      const { record, ...publicResult } = result;
      return json(response, 200, { ok: true, ...publicResult, cloud });
    }

    return json(response, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    console.error('[qq-archive]', error);
    return json(response, error.statusCode || 500, { ok: false, error: error.message });
  }
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[qq-archive] 收到 ${signal}，正在停止`);
  server.close(async () => {
    cloudForwarder.stop();
    await processLock.release();
    process.exit(0);
  });
  setTimeout(async () => {
    cloudForwarder.stop();
    await processLock.release();
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', async (error) => {
  console.error('[qq-archive] 未捕获异常', error);
  await processLock.release();
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  console.log(`[qq-archive] 监听 http://${config.host}:${config.port}`);
  console.log(`[qq-archive] OneBot 上报地址 http://${config.host}:${config.port}/onebot/events`);
  console.log(`[qq-archive] 数据目录 ${config.archiveRoot}`);
});
