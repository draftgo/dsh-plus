// Loaded by the user's Pi runtime. Import is type-only: this plugin does not
// depend on a second installation of Pi or change its global configuration.
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';

export default function commanderPermissions(pi: ExtensionAPI) {
  if (process.env.COMMANDER_DELEGATE_URL) pi.registerTool({
    name: 'commander_delegate', label: 'Commander', description: 'Delegate a task to another coding engine in the same project. Requires human approval.',
    parameters: Type.Object({ provider: Type.Optional(Type.Union(['codex', 'claude', 'pi', 'opencode'].map(s => Type.Literal(s)))), text: Type.Optional(Type.String()), model: Type.Optional(Type.String()), operation: Type.Optional(Type.Union([Type.Literal('delegate'), Type.Literal('result')])), sessionId: Type.Optional(Type.String()) }),
    async execute(_id, args, signal) {
      const response = await fetch(process.env.COMMANDER_DELEGATE_URL!, { method: 'POST', headers: { authorization: `Bearer ${process.env.COMMANDER_DELEGATE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(args), signal });
      const value = await response.text(); if (!response.ok) throw new Error(value);
      return { content: [{ type: 'text', text: value }], details: {} };
    },
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!ctx.hasUI) return { block: true, reason: 'Commander approval channel is unavailable' };
    const allowed = await ctx.ui.confirm(
      `Commander: ${event.toolName}`,
      JSON.stringify({ toolCallId: event.toolCallId, input: event.input }),
    );
    if (!allowed) return { block: true, reason: 'Denied by Commander user' };
  });
}
