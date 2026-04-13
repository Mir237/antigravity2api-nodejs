import assert from 'node:assert/strict';
import { normalizeToolProtocol } from '../src/utils/toolProtocolIntegrity.js';
import { generateRequestBody } from '../src/utils/converters/openai.js';
import { generateGeminiRequestBody } from '../src/utils/converters/gemini.js';
import { convertToGeminiCli } from '../src/utils/converters/geminicli.js';
import {
  clearThoughtSignatureCaches,
  getToolCallSignature,
  setToolCallSignature
} from '../src/utils/thoughtSignatureCache.js';
import config from '../src/config/config.js';

const mockToken = {
  sessionId: 'tool-protocol-test-session',
  projectId: 'test-project'
};

function testNormalizerRepairsOrphanToolCalls() {
  const contents = [
    {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'call_missing_result',
            name: 'search_docs',
            args: { q: 'tool protocol' }
          }
        }
      ]
    },
    {
      role: 'model',
      parts: [{ text: 'done' }]
    }
  ];

  const normalized = normalizeToolProtocol(contents);
  assert.equal(normalized.length, 3);
  assert.equal(normalized[1].role, 'user');
  assert.deepEqual(normalized[1].parts[0], {
    functionResponse: {
      id: 'call_missing_result',
      name: 'search_docs',
      response: { output: '' }
    }
  });
}

function testNormalizerDropsOrphanToolResults() {
  const contents = [
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'missing_call',
            name: 'ghost_tool',
            response: { output: 'orphan' }
          }
        }
      ]
    },
    {
      role: 'user',
      parts: [{ text: 'keep me' }]
    }
  ];

  const normalized = normalizeToolProtocol(contents);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].parts[0].text, 'keep me');
}

function testOpenAISignatureLookupUsesToolCallId() {
  const originalUseFallbackSignature = config.useFallbackSignature;
  config.useFallbackSignature = false;

  clearThoughtSignatureCaches();
  setToolCallSignature(mockToken.sessionId, 'gemini-2.5-pro', 'call_precise_sig', 'sig-precise');

  const requestBody = generateRequestBody(
    [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_precise_sig',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: JSON.stringify({ city: 'Shanghai' })
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_precise_sig',
        content: 'sunny'
      }
    ],
    'gemini-2.5-pro',
    {},
    [
      {
        type: 'function',
        function: {
          name: 'lookup_weather',
          description: 'Lookup weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } }
        }
      }
    ],
    mockToken
  );

  const toolCallPart = requestBody.request.contents[1].parts[0];
  assert.equal(toolCallPart.functionCall.id, 'call_precise_sig');
  assert.equal(toolCallPart.thoughtSignature, 'sig-precise');

  config.useFallbackSignature = originalUseFallbackSignature;
}

function testGeminiSignatureLookupUsesToolCallId() {
  const originalUseFallbackSignature = config.useFallbackSignature;
  config.useFallbackSignature = false;

  clearThoughtSignatureCaches();
  setToolCallSignature(mockToken.sessionId, 'gemini-2.5-pro', 'call_gemini_sig', 'sig-gemini');

  const requestBody = generateGeminiRequestBody(
    {
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_gemini_sig',
                name: 'read_url',
                args: { url: 'https://example.com' }
              }
            }
          ]
        }
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_url',
              description: 'Read a URL',
              parameters: { type: 'object', properties: { url: { type: 'string' } } }
            }
          ]
        }
      ]
    },
    'gemini-2.5-pro',
    mockToken
  );

  const toolCallPart = requestBody.request.contents[1].parts[0];
  assert.equal(toolCallPart.functionCall.id, 'call_gemini_sig');
  assert.equal(toolCallPart.thoughtSignature, 'sig-gemini');
  assert.equal(getToolCallSignature(mockToken.sessionId, 'gemini-2.5-pro', 'call_gemini_sig')?.signature, 'sig-gemini');

  config.useFallbackSignature = originalUseFallbackSignature;
}

function testGeminiDoesNotImplicitlyCopyThoughtSignatureToToolCall() {
  const originalUseFallbackSignature = config.useFallbackSignature;
  config.useFallbackSignature = false;

  clearThoughtSignatureCaches();

  const requestBody = generateGeminiRequestBody(
    {
      contents: [
        { role: 'user', parts: [{ text: 'hello' }] },
        {
          role: 'model',
          parts: [
            {
              text: 'internal reasoning',
              thought: true,
              thoughtSignature: 'sig-current-gemini'
            },
            {
              functionCall: {
                id: 'call_current_sig',
                name: 'read_url',
                args: { url: 'https://example.com' }
              }
            }
          ]
        }
      ],
      tools: [
        {
          functionDeclarations: [
            {
              name: 'read_url',
              description: 'Read a URL',
              parameters: { type: 'object', properties: { url: { type: 'string' } } }
            }
          ]
        }
      ]
    },
    'gemini-2.5-pro',
    mockToken
  );

  const toolCallPart = requestBody.request.contents[1].parts.find((part) => part.functionCall);
  assert.equal(toolCallPart.thoughtSignature, undefined);

  config.useFallbackSignature = originalUseFallbackSignature;
}

function testGeminiCliSignatureLookupUsesToolCallId() {
  clearThoughtSignatureCaches();
  setToolCallSignature(null, 'gemini-2.5-pro', 'call_cli_sig', 'sig-cli');

  const { geminiRequest } = convertToGeminiCli({
    model: 'gemini-2.5-pro',
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_cli_sig',
            type: 'function',
            function: {
              name: 'read_url',
              arguments: JSON.stringify({ url: 'https://example.com' })
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'call_cli_sig', content: 'ok' }
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_url',
          description: 'Read a URL',
          parameters: { type: 'object', properties: { url: { type: 'string' } } }
        }
      }
    ]
  });

  const toolCallPart = geminiRequest.contents[1].parts.find((part) => part.functionCall);
  assert.equal(toolCallPart.functionCall.id, 'call_cli_sig');
  assert.equal(toolCallPart.thoughtSignature, 'sig-cli');
}

function testGeminiCliDoesNotImplicitlyCopyThoughtSignatureToToolCall() {
  clearThoughtSignatureCaches();

  const { geminiRequest } = convertToGeminiCli({
    model: 'gemini-2.5-pro',
    contents: [
      { role: 'user', parts: [{ text: 'hello' }] },
      {
        role: 'model',
        parts: [
          {
            text: 'internal reasoning',
            thought: true,
            thoughtSignature: 'sig-current-cli'
          },
          {
            functionCall: {
              id: 'call_current_cli_sig',
              name: 'read_url',
              args: { url: 'https://example.com' }
            }
          }
        ]
      }
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'read_url',
            description: 'Read a URL',
            parameters: { type: 'object', properties: { url: { type: 'string' } } }
          }
        ]
      }
    ]
  });

  const toolCallPart = geminiRequest.contents[1].parts.find((part) => part.functionCall);
  assert.equal(toolCallPart.thoughtSignature, undefined);
}

function testOpenAIGeminiDoesNotImplicitlyCopyMessageThoughtSignatureToToolCall() {
  const originalUseFallbackSignature = config.useFallbackSignature;
  config.useFallbackSignature = false;

  clearThoughtSignatureCaches();

  const requestBody = generateRequestBody(
    [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'internal reasoning',
        thoughtSignature: 'sig-openai-message',
        tool_calls: [
          {
            id: 'call_openai_sig',
            type: 'function',
            function: {
              name: 'lookup_weather',
              arguments: JSON.stringify({ city: 'Shanghai' })
            }
          }
        ]
      },
      {
        role: 'tool',
        tool_call_id: 'call_openai_sig',
        content: 'sunny'
      }
    ],
    'gemini-2.5-pro',
    {},
    [
      {
        type: 'function',
        function: {
          name: 'lookup_weather',
          description: 'Lookup weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } }
        }
      }
    ],
    mockToken
  );

  const modelMessage = requestBody.request.contents.find((content) => content.role === 'model');
  const toolCallPart = modelMessage.parts.find((part) => part.functionCall);
  assert.equal(toolCallPart.thoughtSignature, undefined);

  config.useFallbackSignature = originalUseFallbackSignature;
}

testNormalizerRepairsOrphanToolCalls();
testNormalizerDropsOrphanToolResults();
testOpenAISignatureLookupUsesToolCallId();
testOpenAIGeminiDoesNotImplicitlyCopyMessageThoughtSignatureToToolCall();
testGeminiSignatureLookupUsesToolCallId();
testGeminiDoesNotImplicitlyCopyThoughtSignatureToToolCall();
testGeminiCliSignatureLookupUsesToolCallId();
testGeminiCliDoesNotImplicitlyCopyThoughtSignatureToToolCall();

console.log('tool protocol integrity tests passed');
