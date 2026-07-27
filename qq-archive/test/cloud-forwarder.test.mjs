import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CloudForwarder, resolveArchiveFile } from '../src/cloud-forwarder.mjs';

function configFor(archiveRoot, overrides = {}) {
  return {
    archiveRoot,
    cloudIngestUrl: 'https://example.test/ingest',
    cloudIngestToken: 'secret',
    cloudGroupIds: new Set(['731332881']),
    cloudRetryMs: 60_000,
    cloudTimeoutMs: 1000,
    cloudMaxImageBytes: 8 * 1024 * 1024,
    cloudUploadChunkBytes: 48 * 1024,
    ...overrides
  };
}

function successFor(payload) {
  if (payload.action === 'uploadQQMediaChunk') {
    return {
      ok: true,
      data: {
        fileId: `cloud://env.bucket/qq-review-staging/test/${payload.chunkIndex}.part`
      }
    };
  }
  if (payload.action === 'completeQQMediaUpload') {
    return {
      ok: true,
      data: {
        media: {
          fileId: `cloud://env.bucket/qq-review/test/${payload.sha256.slice(0, 24)}.jpg`,
          contentType: payload.contentType,
          bytes: payload.bytes,
          sha256: payload.sha256,
          originalFile: payload.originalFile
        }
      }
    };
  }
  return { ok: true, data: { status: 'pending' } };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('cloud forwarder keeps a failed job and removes it after success', async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forwarder-'));
  const imagePath = path.join(archiveRoot, 'archive-media', 'test.jpg');
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, Buffer.from('image'));
  let shouldFail = true;
  const calls = [];
  const forwarder = new CloudForwarder(configFor(archiveRoot), {
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body);
      calls.push(payload);
      return shouldFail
        ? response({ message: 'offline' }, 503)
        : response(successFor(payload));
    }
  });

  try {
    await forwarder.init();
    forwarder.stop();
    await forwarder.enqueue({
      group_id: '731332881',
      message_id: '1',
      images: [{ relative_path: 'archive-media/test.jpg', original_file: 'test.jpg' }]
    });
    await forwarder.flush();
    assert.equal((await fs.readdir(forwarder.outboxDirectory)).length, 1);

    shouldFail = false;
    await forwarder.flush();
    assert.equal((await fs.readdir(forwarder.outboxDirectory)).length, 0);
    const ingest = calls.findLast((payload) => payload.action === 'ingestQQMessage');
    assert.equal(ingest.mediaRefs.length, 1);
    assert.equal('base64' in ingest.mediaRefs[0], false);
    assert.equal(forwarder.getStats().queued, 0);
  } finally {
    forwarder.stop();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('large image uses bounded chunks and a controlled media reference', async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forwarder-large-'));
  const imagePath = path.join(archiveRoot, 'archive-media', 'large.jpg');
  const image = Buffer.alloc(233_797, 7);
  await fs.mkdir(path.dirname(imagePath), { recursive: true });
  await fs.writeFile(imagePath, image);
  const requests = [];
  const forwarder = new CloudForwarder(configFor(archiveRoot), {
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ payload, bodyLength: options.body.length });
      return response(successFor(payload));
    }
  });

  try {
    await forwarder.init();
    forwarder.stop();
    await forwarder.enqueue({
      group_id: '731332881',
      message_id: 'large-1',
      images: [{ relative_path: 'archive-media/large.jpg', original_file: 'large.jpg' }]
    });
    await forwarder.flush();

    const chunks = requests.filter(({ payload }) => payload.action === 'uploadQQMediaChunk');
    const completed = requests.find(({ payload }) => payload.action === 'completeQQMediaUpload');
    const ingest = requests.find(({ payload }) => payload.action === 'ingestQQMessage');
    assert.equal(chunks.length, Math.ceil(image.length / (48 * 1024)));
    assert.equal(Math.max(...chunks.map(({ bodyLength }) => bodyLength)) < 100_000, true);
    assert.equal(completed.payload.parts.length, chunks.length);
    assert.equal(ingest.payload.mediaRefs.length, 1);
    assert.equal(JSON.stringify(ingest.payload).includes('chunkBase64'), false);
    assert.equal((await fs.readdir(forwarder.outboxDirectory)).length, 0);
  } finally {
    forwarder.stop();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('a failed job does not block later outbox jobs', async () => {
  const archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-forwarder-order-'));
  const delivered = [];
  let firstJobFails = true;
  const forwarder = new CloudForwarder(configFor(archiveRoot), {
    fetch: async (_url, options) => {
      const payload = JSON.parse(options.body);
      if (payload.action !== 'ingestQQMessage') return response(successFor(payload));
      if (payload.record.message_id === '1' && firstJobFails) {
        return response({ message: 'first job failed' }, 503);
      }
      delivered.push(payload.record.message_id);
      return response(successFor(payload));
    }
  });

  try {
    await forwarder.init();
    forwarder.stop();
    await forwarder.enqueue({ group_id: '731332881', message_id: '1', images: [] });
    await forwarder.flush();
    await forwarder.enqueue({ group_id: '731332881', message_id: '2', images: [] });
    await forwarder.flush();

    assert.deepEqual(delivered, ['2']);
    assert.deepEqual(await fs.readdir(forwarder.outboxDirectory), ['731332881-1.json']);
    assert.equal(forwarder.getStats().queued, 1);

    firstJobFails = false;
    await forwarder.flush();
    assert.equal((await fs.readdir(forwarder.outboxDirectory)).length, 0);
    assert.deepEqual(delivered, ['2', '1']);
  } finally {
    forwarder.stop();
    await fs.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('archive path traversal is rejected', () => {
  assert.throws(() => resolveArchiveFile('C:/archive', '../secret.jpg'));
});
