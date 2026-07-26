const LOST_TERMS = [
  '丢了', '丢失', '遗失', '不见了', '找不到', '寻找', '寻物', '有人看到', '有没有人看到',
  '落下了', '忘在', '我的东西', 'lost'
];

const FOUND_TERMS = [
  '捡到', '拾到', '谁的', '失物招领', '招领', '认领', '发现一个', '发现了', '落在这里',
  '交到', 'found'
];

function decodeCqValue(value = '') {
  return String(value)
    .replaceAll('&#44;', ',')
    .replaceAll('&#91;', '[')
    .replaceAll('&#93;', ']')
    .replaceAll('&amp;', '&');
}

export function parseCqMessage(rawMessage = '') {
  const source = String(rawMessage);
  const segments = [];
  const pattern = /\[CQ:([^,\]]+)((?:,[^=\]]+=[^\]]*)*)\]/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      segments.push({ type: 'text', data: { text: decodeCqValue(source.slice(cursor, match.index)) } });
    }

    const data = {};
    for (const part of match[2].replace(/^,/, '').split(',')) {
      if (!part) continue;
      const separator = part.indexOf('=');
      if (separator === -1) continue;
      data[part.slice(0, separator)] = decodeCqValue(part.slice(separator + 1));
    }
    segments.push({ type: match[1], data });
    cursor = pattern.lastIndex;
  }

  if (cursor < source.length) {
    segments.push({ type: 'text', data: { text: decodeCqValue(source.slice(cursor)) } });
  }

  return segments.length ? segments : [{ type: 'text', data: { text: source } }];
}

function normalizeSegments(message, rawMessage) {
  if (Array.isArray(message)) {
    return message.map((segment) => ({
      type: String(segment?.type || 'unknown'),
      data: segment?.data && typeof segment.data === 'object' ? segment.data : {}
    }));
  }
  if (typeof message === 'string') return parseCqMessage(message);
  return parseCqMessage(rawMessage || '');
}

export function classifyLostFound(text = '') {
  const normalized = String(text).toLowerCase();
  const lostMatches = LOST_TERMS.filter((term) => normalized.includes(term.toLowerCase()));
  const foundMatches = FOUND_TERMS.filter((term) => normalized.includes(term.toLowerCase()));

  if (!lostMatches.length && !foundMatches.length) {
    return { type: 'unknown', confidence: 0, matched_keywords: [] };
  }

  if (lostMatches.length === foundMatches.length) {
    const firstLost = Math.min(...lostMatches.map((term) => normalized.indexOf(term.toLowerCase())));
    const firstFound = Math.min(...foundMatches.map((term) => normalized.indexOf(term.toLowerCase())));
    const type = firstLost <= firstFound ? 'lost' : 'found';
    return {
      type,
      confidence: 0.55,
      matched_keywords: type === 'lost' ? lostMatches : foundMatches
    };
  }

  const type = lostMatches.length > foundMatches.length ? 'lost' : 'found';
  const count = Math.max(lostMatches.length, foundMatches.length);
  return {
    type,
    confidence: Math.min(0.95, 0.65 + (count - 1) * 0.1),
    matched_keywords: type === 'lost' ? lostMatches : foundMatches
  };
}

export function toShanghaiIso(value) {
  let milliseconds;
  if (typeof value === 'number') {
    milliseconds = value < 10_000_000_000 ? value * 1000 : value;
  } else {
    milliseconds = Date.parse(value);
  }
  if (!Number.isFinite(milliseconds)) milliseconds = Date.now();
  return new Date(milliseconds + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

function textFromSegments(segments) {
  return segments
    .filter((segment) => segment.type === 'text')
    .map((segment) => String(segment.data?.text || ''))
    .join('')
    .trim();
}

function deriveMessageType(segments) {
  const meaningfulTypes = new Set(
    segments
      .map((segment) => segment.type)
      .filter((type) => type && type !== 'reply' && type !== 'at')
  );
  if (meaningfulTypes.size > 1) return 'mixed';
  if (meaningfulTypes.has('image')) return 'image';
  if (meaningfulTypes.has('text')) return 'text';
  return meaningfulTypes.values().next().value || 'unknown';
}

export function normalizeOneBotEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ignored: true, reason: '请求体不是事件对象' };
  }

  const postType = payload.post_type || (payload.group_id ? 'message' : '');
  const messageScope = payload.message_type || (payload.group_id ? 'group' : '');
  if (postType !== 'message' && postType !== 'message_sent') {
    return { ignored: true, reason: '不是消息事件' };
  }
  if (messageScope !== 'group') {
    return { ignored: true, reason: '不是群消息' };
  }

  const groupId = String(payload.group_id || '').trim();
  const messageId = String(payload.message_id || payload.id || '').trim();
  const senderId = String(payload.user_id || payload.sender?.user_id || '').trim();
  if (!groupId || !messageId) {
    return { ignored: true, reason: '缺少 group_id 或 message_id' };
  }

  const segments = normalizeSegments(payload.message, payload.raw_message);
  const text = textFromSegments(segments);
  const imageSegments = segments
    .map((segment, index) => ({ ...segment, index }))
    .filter((segment) => segment.type === 'image');
  const senderName = String(
    payload.sender?.card
    || payload.sender?.nickname
    || payload.sender_name
    || senderId
    || '未知成员'
  );

  return {
    ignored: false,
    group_id: groupId,
    message_id: messageId,
    time: toShanghaiIso(payload.time || payload.timestamp),
    sender_id: senderId,
    sender_name: senderName,
    message_type: deriveMessageType(segments),
    content: text || (imageSegments.length ? `[图片 × ${imageSegments.length}]` : String(payload.raw_message || '')),
    segments,
    image_segments: imageSegments,
    lost_found: classifyLostFound(text)
  };
}
