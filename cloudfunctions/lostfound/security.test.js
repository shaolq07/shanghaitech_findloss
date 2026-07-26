'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRateLimiter,
  resolveCallerId,
  toPublicRecord,
  validateVisionInput
} = require('./security');

test('toPublicRecord removes identity and embedding fields', () => {
  const record = toPublicRecord({
    _id: 'item-1',
    ownerOpenid: 'user-1',
    authorOpenid: 'user-2',
    title: '黑色雨伞',
    imageEmbedding: [0.1],
    semanticEmbedding: [0.2]
  }, 'user-1');
  assert.deepEqual(record, { _id: 'item-1', title: '黑色雨伞', isMine: true });
});

test('resolveCallerId supports WeChat and CloudBase Web contexts', () => {
  assert.equal(resolveCallerId({ OPENID: 'wx-user' }, {}), 'wx-user');
  assert.equal(resolveCallerId({}, { auth: { uid: 'web-user' } }), 'web-user');
});

test('validateVisionInput rejects oversized and unsupported images', () => {
  assert.equal(validateVisionInput({ imageBase64: 'abc', mimeType: 'image/gif' }).code, 'UNSUPPORTED_IMAGE_TYPE');
  assert.equal(validateVisionInput({ imageBase64: 'x'.repeat(7 * 1024 * 1024 + 1) }).code, 'IMAGE_TOO_LARGE');
  assert.equal(validateVisionInput({ imageBase64: 'abc', mimeType: 'image/jpeg' }).ok, true);
});

test('rate limiter blocks requests after the configured limit', () => {
  const limiter = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(limiter.check('user', 0).allowed, true);
  assert.equal(limiter.check('user', 100).allowed, true);
  assert.equal(limiter.check('user', 200).allowed, false);
  assert.equal(limiter.check('user', 1200).allowed, true);
});
