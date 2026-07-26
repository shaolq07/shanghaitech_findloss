import readline from 'node:readline';
import { ArchiveReader } from './archive-reader.mjs';
import { loadConfig } from './config.mjs';

const config = loadConfig();
const reader = new ArchiveReader(config.archiveRoot);

const tools = [
  {
    name: 'qq_archive_list_groups',
    description: '列出已经归档的 QQ 群及其消息数量和时间范围。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'qq_archive_search_messages',
    description: '按群号、发送者、寻物/发现类型、关键词和时间范围查询已归档 QQ 群消息。',
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'string', description: '可选，QQ 群号。' },
        sender_id: { type: 'string', description: '可选，发送者 QQ 号。' },
        lost_found_type: {
          type: 'string',
          enum: ['lost', 'found', 'unknown'],
          description: '可选，消息的寻物/发现分类。'
        },
        query: { type: 'string', description: '可选，搜索正文、发送者名称、消息号或图片文件名。' },
        since: { type: 'string', description: '可选，ISO 8601 起始时间。' },
        until: { type: 'string', description: '可选，ISO 8601 结束时间。' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: 'qq_archive_get_message',
    description: '用群号和消息号读取一条完整的归档消息。',
    inputSchema: {
      type: 'object',
      required: ['group_id', 'message_id'],
      properties: {
        group_id: { type: 'string' },
        message_id: { type: 'string' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'qq_archive_list_media',
    description: '读取 QQ聊天记录 内现有图片的哈希、消息对应、人工物品分组和隐私标记。',
    inputSchema: {
      type: 'object',
      properties: {
        only_unlinked: {
          type: 'boolean',
          default: false,
          description: '只返回尚未对应到群消息的图片。'
        }
      },
      additionalProperties: false
    }
  }
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function callTool(name, args) {
  switch (name) {
    case 'qq_archive_list_groups':
      return reader.listGroups();
    case 'qq_archive_search_messages':
      return reader.searchMessages(args);
    case 'qq_archive_get_message':
      return reader.getMessage(args?.group_id, args?.message_id);
    case 'qq_archive_list_media':
      return reader.listMedia(args);
    default:
      throw new Error(`未知工具：${name}`);
  }
}

async function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || !request.method) {
    if (request?.id !== undefined) error(request.id, -32600, '无效 JSON-RPC 请求');
    return;
  }

  if (request.method === 'initialize') {
    result(request.id, {
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'lockmyitem-qq-archive', version: '0.1.0' }
    });
    return;
  }

  if (request.method === 'ping') {
    result(request.id, {});
    return;
  }

  if (request.method === 'tools/list') {
    result(request.id, { tools });
    return;
  }

  if (request.method === 'tools/call') {
    try {
      const value = await callTool(request.params?.name, request.params?.arguments || {});
      result(request.id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        structuredContent: { result: value },
        isError: false
      });
    } catch (toolError) {
      result(request.id, {
        content: [{ type: 'text', text: toolError.message }],
        isError: true
      });
    }
    return;
  }

  if (request.id !== undefined) error(request.id, -32601, `不支持的方法：${request.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on('line', (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    try {
      await handle(JSON.parse(line.replace(/^\uFEFF/, '')));
    } catch {
      error(null, -32700, 'JSON 解析失败');
    }
  });
});
