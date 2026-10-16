/** The host supplies the durable default identity; titles and directory spellings are never identity. */
export function isRecentWorkspace(workspace){return workspace?.isDefault===true;}
export const recentWorkspace=projects=>projects.find(isRecentWorkspace);
export const projectWorkspaces=projects=>projects.filter(project=>!isRecentWorkspace(project));
export function recentRows(rows,projects){const defaults=new Set(projects.filter(isRecentWorkspace).map(p=>p.id??p.workspaceId));return rows.filter(row=>defaults.has(row.projectId)||projects.some(p=>isRecentWorkspace(p)&&typeof p.path==='string'&&p.path.length>0&&p.path===row.cwd));}
export function displayWorkspaceTitle(workspace){return isRecentWorkspace(workspace)?'最近':workspace.title;}
/** The official workspace snapshot is authoritative once ready, including an empty list. */
export function sidebarWorkspaces(snapshot,fallback=[],defaultId){
  const items=snapshot?.items;
  const source=snapshot?.phase==='ready'||items?.length>0?items??[]:fallback;
  const previous=new Map(fallback.map(project=>[project.id??project.workspaceId,project]));
  return source.map(project=>{
    const id=project.workspaceId??project.id;
    return {...project,id,sessionIds:project.sessionIds??[],isDefault:defaultId!=null?id===defaultId:(previous.get(id)?.isDefault??project.isDefault)===true};
  });
}
/** Missing active identity must never match an absent owner; delegates remain independent rows. */
export function isSidebarSessionSelected(session,activeSessionId){
  return typeof activeSessionId==='string'&&activeSessionId.length>0&&(session.id===activeSessionId||(session.native===true&&session.ownerSessionId===activeSessionId&&(!session.parentId||session.harnessAdopted===true)));
}
/** Explicit identity avoids the official current/recent-project fallback on generic New Chat. */
export async function startSidebarSession(host,projects,projectId,defaultId){
  const current=sidebarWorkspaces(host.workspaces.list?.getSnapshot(),projects,defaultId);
  let target=projectId??recentWorkspace(current)?.id;
  if(!target){const initialized=await host.workspaces.initializeDefault();target=initialized?.workspaceId;}
  if(!target)throw Error('未找到最近工作区，请先完成默认工作区初始化');
  host.uiWorkspace.startSession(target);return target;
}
