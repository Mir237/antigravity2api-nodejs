import assert from 'node:assert/strict';
import { generateRequestBody } from '../src/utils/converters/openai.js';

const mockToken = {
  sessionId: 'test-transform-session',
  projectId: 'test-project'
};

const testMessages = [
  {
    role: 'user',
    content: '帮我查询天气和新闻'
  },
  {
    role: 'assistant',
    content: '好的，我来帮你查询。'
  },
  {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_001',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: JSON.stringify({ city: '北京' })
        }
      },
      {
        id: 'call_002',
        type: 'function',
        function: {
          name: 'get_news',
          arguments: JSON.stringify({ category: '科技' })
        }
      }
    ]
  },
  {
    role: 'tool',
    tool_call_id: 'call_001',
    content: '北京今天晴，温度25度'
  },
  {
    role: 'tool',
    tool_call_id: 'call_002',
    content: '最新科技新闻：AI技术突破'
  }
];

const emptyAssistantMessages = [
  {
    role: 'user',
    content: '调用工具'
  },
  {
    role: 'assistant',
    content: ''
  },
  {
    role: 'user',
    content: '继续'
  }
];

const testTools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '获取天气信息',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description: '获取新闻',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string' }
        }
      }
    }
  }
];

const result = generateRequestBody(
  testMessages,
  'claude-sonnet-4-5',
  {},
  testTools,
  mockToken
);

const contents = result.request.contents;

assert.equal(contents.length, 3);
assert.equal(contents[0]?.role, 'user');
assert.equal(contents[0]?.parts?.[0]?.text, '帮我查询天气和新闻');

assert.equal(contents[1]?.role, 'model');
assert.equal(contents[1]?.parts?.[0]?.text, '好的，我来帮你查询。');
assert.equal(contents[1]?.parts?.length, 3);
assert.equal(contents[1]?.parts?.[1]?.functionCall?.id, 'call_001');
assert.equal(contents[1]?.parts?.[1]?.functionCall?.name, 'get_weather');
assert.deepEqual(contents[1]?.parts?.[1]?.functionCall?.args, { city: '北京' });
assert.equal(contents[1]?.parts?.[2]?.functionCall?.id, 'call_002');
assert.equal(contents[1]?.parts?.[2]?.functionCall?.name, 'get_news');
assert.deepEqual(contents[1]?.parts?.[2]?.functionCall?.args, { category: '科技' });

assert.equal(contents[2]?.role, 'user');
assert.equal(contents[2]?.parts?.length, 2);
assert.equal(contents[2]?.parts?.[0]?.functionResponse?.id, 'call_001');
assert.equal(contents[2]?.parts?.[0]?.functionResponse?.name, 'get_weather');
assert.equal(contents[2]?.parts?.[0]?.functionResponse?.response?.output, '北京今天晴，温度25度');
assert.equal(contents[2]?.parts?.[1]?.functionResponse?.id, 'call_002');
assert.equal(contents[2]?.parts?.[1]?.functionResponse?.name, 'get_news');
assert.equal(contents[2]?.parts?.[1]?.functionResponse?.response?.output, '最新科技新闻：AI技术突破');

const emptyAssistantResult = generateRequestBody(
  emptyAssistantMessages,
  'gemini-2.5-pro',
  {},
  [],
  mockToken
);

assert.equal(emptyAssistantResult.request.contents.length, 2);
assert.equal(emptyAssistantResult.request.contents[0]?.role, 'user');
assert.equal(emptyAssistantResult.request.contents[0]?.parts?.[0]?.text, '调用工具');
assert.equal(emptyAssistantResult.request.contents[1]?.role, 'user');
assert.equal(emptyAssistantResult.request.contents[1]?.parts?.[0]?.text, '继续');

console.log('transform tests passed');
