import { generateToolCallId } from './idGenerator.js';

function createSyntheticFunctionResponse(toolCallId, functionName) {
  return {
    functionResponse: {
      id: toolCallId,
      name: functionName || '',
      response: { output: '' }
    }
  };
}

function cloneFunctionCallPart(part) {
  if (!part?.functionCall) return part;
  const functionCall = { ...part.functionCall };
  if (!functionCall.id) {
    functionCall.id = generateToolCallId();
  }
  return {
    ...part,
    functionCall
  };
}

function cloneFunctionResponsePart(part, pendingCalls) {
  if (!part?.functionResponse) return null;

  const functionResponse = { ...part.functionResponse };
  if (!functionResponse.id && pendingCalls.size === 1) {
    functionResponse.id = pendingCalls.keys().next().value;
  }

  if (!functionResponse.id || !pendingCalls.has(functionResponse.id)) {
    return null;
  }

  const pendingCall = pendingCalls.get(functionResponse.id);
  if (!functionResponse.name) {
    functionResponse.name = pendingCall?.name || '';
  }
  if (!functionResponse.response || typeof functionResponse.response !== 'object') {
    functionResponse.response = { output: '' };
  } else if (functionResponse.response.output === undefined) {
    functionResponse.response = {
      ...functionResponse.response,
      output: ''
    };
  }

  pendingCalls.delete(functionResponse.id);
  return {
    ...part,
    functionResponse
  };
}

function flushPendingCalls(pendingCalls, normalizedContents) {
  if (pendingCalls.size === 0) return;

  const parts = [];
  for (const pendingCall of pendingCalls.values()) {
    parts.push(createSyntheticFunctionResponse(pendingCall.id, pendingCall.name));
  }

  normalizedContents.push({
    role: 'user',
    parts
  });
  pendingCalls.clear();
}

export function normalizeToolProtocol(contents) {
  if (!Array.isArray(contents) || contents.length === 0) {
    return Array.isArray(contents) ? contents : [];
  }

  const normalizedContents = [];
  const pendingCalls = new Map();

  for (const content of contents) {
    if (!content || !Array.isArray(content.parts)) {
      if (content?.role === 'model') {
        flushPendingCalls(pendingCalls, normalizedContents);
      }
      normalizedContents.push(content);
      continue;
    }

    if (content.role === 'model') {
      flushPendingCalls(pendingCalls, normalizedContents);

      const parts = content.parts.map((part) => {
        const normalizedPart = cloneFunctionCallPart(part);
        if (normalizedPart?.functionCall?.id) {
          pendingCalls.set(normalizedPart.functionCall.id, {
            id: normalizedPart.functionCall.id,
            name: normalizedPart.functionCall.name || ''
          });
        }
        return normalizedPart;
      });

      normalizedContents.push({
        ...content,
        parts
      });
      continue;
    }

    if (content.role !== 'user') {
      normalizedContents.push(content);
      continue;
    }

    const responseParts = [];
    const regularParts = [];

    for (const part of content.parts) {
      if (part?.functionResponse) {
        const normalizedPart = cloneFunctionResponsePart(part, pendingCalls);
        if (normalizedPart) {
          responseParts.push(normalizedPart);
        }
      } else {
        regularParts.push(part);
      }
    }

    if (responseParts.length > 0) {
      normalizedContents.push({
        ...content,
        parts: responseParts
      });
    }

    if (regularParts.length > 0) {
      flushPendingCalls(pendingCalls, normalizedContents);
      normalizedContents.push({
        ...content,
        parts: regularParts
      });
    }
  }

  flushPendingCalls(pendingCalls, normalizedContents);
  return normalizedContents;
}
