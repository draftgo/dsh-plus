/** Provider-native slash commands; never interpret arbitrary text as shell input. */
export function normalizeCommand(name, args = '') {
  if (typeof name !== 'string' || !/^[\w.:-]{1,120}$/.test(name.replace(/^\//, ''))) throw new Error('Invalid native command name');
  if (typeof args !== 'string' || args.length > 20000) throw new Error('Invalid native command arguments');
  return { name: name.replace(/^\//, ''), arguments: args };
}

export const compactCommand = { name: 'compact', description: 'Compress the native conversation context', argumentHint: '', kind: 'command' };

export function commandCatalog(commands = [], builtins = []) {
  const result = new Map(builtins.map(command => [command.name, command]));
  for (const command of commands) {
    if (!command || typeof command.name !== 'string' || !/^[\w.:-]{1,120}$/.test(command.name)) continue;
    if (!result.has(command.name)) result.set(command.name, { name: command.name, description: command.description ?? '', argumentHint: command.argumentHint ?? '', kind: command.kind === 'skill' || command.source === 'skill' ? 'skill' : 'command' });
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}
