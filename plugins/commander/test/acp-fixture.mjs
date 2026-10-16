import { createInterface } from 'node:readline';
const io = createInterface({ input: process.stdin });
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const reject = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32601, message } });
const sessionId = 'acp-native-fixture';
const models = { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Alpha' }, { modelId: 'model-b', name: 'Beta' }] };
const options = [{ id: 'model', category: 'model', type: 'select', currentValue: 'model-a', options: [{ value: 'model-a', name: 'Alpha' }, { value: 'model-b', name: 'Beta' }] }];
let promptId, nativeRequestId, selected = 'model-a';
const update = payload => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: payload } });
const text = value => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
io.on('line', line => {
  const request = JSON.parse(line), params = request.params ?? {};
  if (request.id === nativeRequestId && !request.method) { text(JSON.stringify(request.result ?? request.error)); respond(promptId, { stopReason: 'end_turn' }); return; }
  switch (request.method) {
    case 'initialize':
      if (params.clientCapabilities?.fs?.readTextFile || params.clientCapabilities?.terminal) throw new Error('unexpected privileges');
      if (process.env.ACP_NO_INITIALIZE) return;
      respond(request.id, { protocolVersion: 1, agentCapabilities: { loadSession: !process.env.ACP_NO_RESUME, sessionCapabilities: { list: {} } } }); break;
    case 'session/new': case 'session/load':
      if (process.env.ACP_EXPECT_DELEGATION && JSON.stringify(params.mcpServers) !== process.env.ACP_EXPECT_DELEGATION) return reject(request.id, 'Invalid delegation MCP schema');
      if (process.env.ACP_REJECT_MCP && params.mcpServers?.length) return reject(request.id, 'This agent does not support MCP servers');
      if (request.method === 'session/load' && params.sessionId === 'missing') return reject(request.id, 'Session not found');
      update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compress', input: { hint: 'optional' } }] });
      respond(request.id, { ...(request.method === 'session/new' || process.env.ACP_MISMATCH ? { sessionId: process.env.ACP_MISMATCH ? 'wrong-native-id' : sessionId } : {}), ...(process.env.ACP_CONFIG_MODELS ? { configOptions: options } : { models }) }); break;
    case 'session/set_model': if (process.env.ACP_MODEL_FAILURE) return reject(request.id, 'Model switch failed'); selected = params.modelId; respond(request.id, {}); break;
    case 'session/set_config_option': if (process.env.ACP_MODEL_FAILURE) return reject(request.id, 'Model config switch failed'); selected = params.value; respond(request.id, { configOptions: options }); break;
    case 'session/list': respond(request.id, { sessions: [{ sessionId, cwd: process.cwd(), title: 'Fixture' }] }); break;
    case 'session/cancel': if (process.env.ACP_IGNORE_CANCEL) return; if (promptId) { respond(promptId, { stopReason: 'cancelled' }); promptId = undefined; } break;
    case 'session/prompt': {
      promptId = request.id; const prompt = params.prompt[0].text;
      if (prompt === 'hang') return;
      if (prompt === 'permission' || prompt === 'always' || prompt === 'fs') {
        nativeRequestId = 'agent-request'; send({ jsonrpc: '2.0', id: nativeRequestId, method: prompt === 'fs' ? 'fs/read_text_file' : 'session/request_permission', params: { sessionId, toolCall: { kind: 'execute', title: 'fixture' }, options: [{ kind: 'allow_always', optionId: 'always' }, ...(prompt === 'always' ? [] : [{ kind: 'allow_once', optionId: 'once' }])] } }); return;
      }
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thought' } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', status: 'in_progress' });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed' });
      text(prompt + ':' + selected); respond(request.id, { stopReason: 'end_turn' }); break;
    }
    default: if (request.id) reject(request.id, 'Unknown fixture method');
  }
});
