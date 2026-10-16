/** Read the official durable selection; Agent construction options may be stale. */
export function harnessSelection(ctx, agent) {
  const projected = ctx.get?.('sessionProjections')?.stateOf(agent.session, 'modelSelection');
  return projected?.pending ?? projected?.lastUsed ?? agent.session.requestHeader?.()?.config ?? agent.options;
}
