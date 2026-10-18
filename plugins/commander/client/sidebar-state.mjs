/** The host supplies the durable default identity; titles and directory spellings are never identity. */
export function isRecentWorkspace(workspace){return workspace?.isDefault===true;}
export const recentWorkspace=projects=>projects.find(isRecentWorkspace);
export const projectWorkspaces=projects=>projects.filter(project=>!isRecentWorkspace(project));
export function recentRows(rows,projects){const defaults=new Set(projects.filter(isRecentWorkspace).map(p=>p.id??p.workspaceId));return rows.filter(row=>defaults.has(row.projectId)||projects.some(p=>isRecentWorkspace(p)&&typeof p.path==='string'&&p.path.length>0&&p.path===row.cwd));}
export function displayWorkspaceTitle(workspace){return isRecentWorkspace(workspace)?'最近':workspace.title;}
/** List status follows current interaction/execution facts; a fresh native connection is not a completed turn. */
export function sidebarSessionStatus(official,ui,native){
  if(ui?.pendingInteraction||native?.status==='waiting')return 'waiting';
  if((ui?.running??official?.running)||native?.status==='running')return 'running';
  if(native?.status==='connecting'||native?.status==='failed')return native.status;
  if(native)return native.status==='idle'&&native.turnId?'completed':native.status;
  return official?.blank===false&&(ui?.running??official?.running)===false?'completed':undefined;
}
/** Activity includes official sessions and their native delegates, even without a cwd. */
export function workspaceActivity(project,liveSessions){
  if(!project)return null;
  const id=project.id??project.workspaceId,path=project.path,sessionIds=new Set(project.sessionIds??[]);
  const priority={connecting:1,running:2,waiting:3};
  let activity=null;
  for(const session of liveSessions){
    if(session.archived||!priority[session.status])continue;
    const belongs=(id&&session.projectId===id)||(path&&session.cwd===path)
      ||(session.id&&sessionIds.has(session.id))||(session.ownerSessionId&&sessionIds.has(session.ownerSessionId));
    if(belongs&&(priority[session.status]>(priority[activity]??0)))activity=session.status;
  }
  return activity;
}
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
/** Documents discovery is optional when the Profile recovery service can create Recent. */
export async function ensureSidebarWorkspace(host,recover){
  let initial;
  try{initial=await host.workspaces.initializeDefault();}catch{/* Recovery owns a writable Profile fallback. */}
  return recover({workspaceId:initial?.workspaceId});
}
/** Explicit identity avoids the official current/recent-project fallback on generic New Chat. */
export async function startSidebarSession(host,projects,projectId,defaultId,ensureRecent){
  const current=sidebarWorkspaces(host.workspaces.list?.getSnapshot(),projects,defaultId);
  let target=projectId??recentWorkspace(current)?.id;
  if(projectId==null&&ensureRecent)target=(await ensureRecent())?.workspaceId;
  if(!target){const initialized=await host.workspaces.initializeDefault();target=initialized?.workspaceId;}
  if(!target)throw Error('最近工作区创建失败，请重试');
  host.uiWorkspace.startSession(target);return target;
}
