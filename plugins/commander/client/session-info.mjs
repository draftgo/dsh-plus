/** Export identifiers only; never include credentials, events or approval payloads. */
export function conversationInfo(row, native, project) {
  return {
    title: row.title || '',
    tool: native?.provider || row.provider,
    model: native?.model || row.model || null,
    harnessSessionId: row.native ? native?.ownerSessionId || row.ownerSessionId || null : row.id,
    commanderSessionId: native?.id || (row.native ? row.id : row.nativeId) || null,
    nativeSessionId: native?.nativeId || (row.native ? row.nativeId : null) || null,
    parentSessionId: native?.parentId || row.parentId || null,
    projectId: project?.id || row.projectId || null,
    projectPath: project?.path || native?.cwd || row.cwd || null,
  };
}

export async function copyConversationInfo(info) {
  // Invoke in the user gesture, without awaiting a network request first.
  await navigator.clipboard.writeText(JSON.stringify(info, null, 2));
}
