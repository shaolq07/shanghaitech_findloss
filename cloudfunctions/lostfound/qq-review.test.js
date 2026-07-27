const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectRiskFlags,
  normalizeIncomingRecord,
  normalizeQQMediaRefs,
  orderQQMediaParts,
  parseCsv,
  reviewId,
  sanitizeDraft
} = require('./qq-review');

test('production group is the secure default', () => {
  assert.deepEqual([...parseCsv('')], ['731332881']);
});

test('review id is deterministic per group and message', () => {
  assert.equal(reviewId('731332881', '42'), reviewId('731332881', '42'));
  assert.notEqual(reviewId('731332881', '42'), reviewId('731332881', '43'));
});

test('incoming QQ message is normalized without retaining the raw QQ number', () => {
  const result = normalizeIncomingRecord({
    group_id: 731332881,
    message_id: 42,
    sender_id: 123456789,
    sender_name: '测试同学',
    content: '我在教学中心捡到一个黑色鼠标',
    lost_found: { type: 'found', confidence: 0.8 },
    images: []
  });
  assert.equal(result.groupId, '731332881');
  assert.equal(result.draft.category, '电子产品');
  assert.equal(result.draft.locationId, 'teaching');
  assert.equal(result.senderIdHash.length, 24);
  assert.equal(Object.hasOwn(result, 'senderId'), false);
});

test('PII and image risks are surfaced to the moderator', () => {
  assert.deepEqual(
    detectRiskFlags('手机号 13800138000', [{}]),
    ['IMAGE_REVIEW_REQUIRED', 'PHONE_NUMBER', 'POSSIBLE_PERSONAL_DATA']
  );
});

test('moderator draft is bounded and type constrained', () => {
  const draft = sanitizeDraft({
    type: 'invalid',
    title: 'a'.repeat(200),
    description: '说明',
    category: '电子产品',
    tags: ['鼠标', '鼠标']
  }, { type: 'lost' });
  assert.equal(draft.type, 'lost');
  assert.equal(draft.title.length, 80);
  assert.deepEqual(draft.tags, ['电子产品', '鼠标']);
});

test('cloud media references are restricted to the deterministic review path', () => {
  const digest = 'a'.repeat(64);
  const valid = normalizeQQMediaRefs('qq_test', [{
    fileId: `cloud://env.bucket/qq-review/qq_test/${digest.slice(0, 24)}.jpg`,
    contentType: 'image/jpeg',
    bytes: 233_797,
    sha256: digest,
    originalFile: 'test.jpg'
  }]);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].bytes, 233_797);
  assert.throws(() => normalizeQQMediaRefs('qq_test', [{
    ...valid[0],
    fileId: `cloud://env.bucket/other/${digest.slice(0, 24)}.jpg`
  }]));
});

test('cloud media chunks must be complete, unique and path-bound', () => {
  const directory = 'qq-review-staging/qq_test/0-aaaaaaaaaaaaaaaaaaaaaaaa';
  const part = (index) => ({
    index,
    fileId: `cloud://env.bucket/${directory}/${String(index).padStart(4, '0')}.part`
  });
  assert.deepEqual(
    orderQQMediaParts([part(1), part(0)], 2, directory),
    [part(0).fileId, part(1).fileId]
  );
  assert.throws(() => orderQQMediaParts([part(0)], 2, directory));
  assert.throws(() => orderQQMediaParts([part(0), part(0)], 2, directory));
  assert.throws(() => orderQQMediaParts([
    part(0),
    { index: 1, fileId: 'cloud://env.bucket/other/0001.part' }
  ], 2, directory));
});
