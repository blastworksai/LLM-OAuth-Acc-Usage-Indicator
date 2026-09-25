'use strict';
const vscode=require('vscode');
const path=require('node:path');
const os=require('node:os');
const {readFeeds,readFeedBatches,matchReports,buildRows,SelectionController}=require('./core.cjs');
const {detectProvider}=require('./provider.cjs');
const {connectionForTarget,sameProcess,publicPath,validatePublicConnection}=require('./connection.cjs');
const {readConnectionFeeds}=require('./connection-feed.cjs');
const {buildViewModel,renderContent,renderDocument}=require('./panel.cjs');
const setup=require('./setup.cjs');
const wizard=require('./wizard.cjs');
const {createWizardHost}=require('./wizard-host.cjs');
const {renderWizard}=require('./wizard-view.cjs');
const {createElevate,resolveUser}=require('./elevate.cjs');
const sharedFeed=require('./shared-feed.cjs');
// The intents the wizard's buttons may post (media/account-usage.js); anything else from the webview is ignored.
const WIZARD_INTENTS=new Set(['continue','connect','cancel','retry','copy','close']);
const WIZARD_DONE=new Set(['connected','undone','cancelled']);
// Shell-style display of an argv array, the same quoting wizard-view.cjs shows. Display and clipboard only; never executed.
const SAFE_WORD=/^[A-Za-z0-9_@%+=:,./-]+$/;
const quoteWord=value=>{const word=typeof value==='string'?value:String(value??'');return SAFE_WORD.test(word)?word:`'${word.replace(/'/g,`'\\''`)}'`;};
const argvLine=argv=>Array.isArray(argv)&&argv.length?argv.map(quoteWord).join(' '):null;
// The running activation's cleanup, for deactivate(). VS Code calls deactivate and then disposes the subscriptions;
// both reach the same cleanup, which runs once and hands back the wizard host's dispose promise.
let stopActive=null;

function activate(context) {
  let view, assets={}, lastContent='';
  const pendingCrossUser=new Map(),runtimeVersion=context.extension.packageJSON.version;
  const capacityError=()=>Object.assign(new Error('Too many report directories. Keep at most 128 local, 128 target-user and 128 configured feeds.'),{safeToDisplay:true});
  const bounded=(values)=>{if(!Array.isArray(values)||values.length>128)throw capacityError();return values;};
  const managedDirectories=()=>{
    const saved=context.globalState.get('managedFeedDirectories',[]);
    return [...new Set(bounded(saved).filter(publicPath))];
  };
  const managedConnections=async(includeDisconnected=false)=>{
    const {connections}=await readFeedBatches(managedDirectories(),readConnectionFeeds,{key:'connections',maximum:128});
    return connections.filter(value=>value.connected||includeDisconnected).map(value=>({...value,pendingProcess:pendingCrossUser.get(value.id)}));
  };
  const setupOptions={storagePath:context.globalStorageUri.fsPath,nodePath:process.execPath,
    collectorPath:path.join(context.extensionPath,'collectors','passive.cjs'),
    trustedDirectories:context.globalState.get('trustedDirectories',[])};
  const setupReady=process.platform==='linux'
    ? setup.refreshRuntime(setupOptions).catch(()=>({warnings:['Saved provider connections need attention. Run Account Usage: Connect Provider.']}))
    : Promise.resolve({warnings:[]});
  const getViewModel=()=>({...buildViewModel(controller.state),...(controller.state.needsReconnect?{stale:true,needsReconnect:true}:{})});
  const cardHtml=()=>renderContent(getViewModel(),assets)+(controller.state.needsReconnect?
    '<p class="stale-notice">Last report retained. Reconnect this profile to update its target-user collector.</p><div class="card-actions"><button class="connect-provider" type="button" data-action="connect">Reconnect provider</button></div>':'');
  // Another account's session is connected through the wizard (0.4). While it is not idle it replaces the card body;
  // Close (or a fresh open) moves it on. Its state arrives through onState, never the password.
  let wizardState=wizard.initial(),wizardHost=null,closeWanted=null;
  const wizardActive=()=>wizardState.step!=='idle';
  const wizardContext={};
  try {wizardContext.user=os.userInfo().username;} catch {}
  try {wizardContext.host=os.hostname();} catch {}
  const getHtml=()=>(wizardActive()&&renderWizard(wizardState,wizardContext))||cardHtml();
  const render=()=> {
    if(!view)return;
    const html=getHtml();
    if(html===lastContent)return;
    lastContent=html;
    void view.webview.postMessage({type:'render',html});
  };
  const controller=new SelectionController(async terminal=> {
    if(process.platform!=='linux')return {status:'unsupported',reason:'Account matching currently supports Linux terminal hosts. Local Windows and macOS terminals are not yet supported.'};
    const pid=await terminal.processId;
    if(!pid)return {status:'unavailable',reason:'The terminal does not expose a process on this host.'};
    await setupReady;
    const shared=await managedConnections();
    const connections=[...bounded(await setup.listConnections(setupOptions).catch(()=>[])),...shared];
    const dirs=[...connections.map(connection=>connection.reportDir),
      ...bounded(vscode.workspace.getConfiguration('llmAccountUsage').get('feedDirectories',[]))];
    const {reports,rejected,overflow}=await readFeedBatches(dirs,readFeeds);
    if(overflow)return {status:'unavailable',reason:capacityError().message};
    const result=await matchReports(pid,reports);
    if(result.status==='ready') {
      // Reports remain authoritative. Find the descriptor through its feed,
      // never by assuming every process with one provider/UID uses one profile.
      for(const connection of shared.filter(value=>value.runtimeVersion!==runtimeVersion &&
        value.provider===result.report.provider && value.uid===result.report.process.uid)) {
        const old=await readFeeds([connection.reportDir]);
        if(old.reports.some(value=>JSON.stringify(value)===JSON.stringify(result.report))) {
          const target=await detectProvider(pid,{allowForeign:true});
          if((target?.provider===connection.provider || target?.provider===null) && sameProcess(target.process,result.report.process))
            Object.assign(result,{needsReconnect:true,setupTarget:target,reconnectConnection:connection,
              reconnectTarget:{provider:result.report.provider,process:{...result.report.process}}});
          break;
        }
      }
    }
    if(result.status==='unavailable' && rejected)result.reason='No matching readable report. A report directory is missing, unreadable or unsafe.';
    if(result.status==='unavailable') {
      const target=await detectProvider(pid,{allowForeign:true});
      const connection=connectionForTarget(connections,target);
      if(target&&(!connection || (connection.runtimeVersion&&connection.runtimeVersion!==runtimeVersion)))result.setupTarget=target;
      else if(connection)result.reason='This profile is connected. Waiting for this session to finish a fresh turn.';
      else result.setupTarget={provider:null};
    }
    return result;
  },render);
  const refresh=(quiet=false)=>controller.select(vscode.window.activeTerminal,{quiet});
  const providerName=provider=>({claude:'Claude Code',codex:'Codex',antigravity:'Antigravity'})[provider]||'Provider';
  const showSetupError=error=>vscode.window.showErrorMessage(error?.safeToDisplay===true
    ? error.message : 'Provider setup could not finish. Check that the profile is readable and owned by your user.');
  const withRecovery=async(operation,options)=>{
    try {return await operation(options);}
    catch(error) {
      if(error?.safeToDisplay!==true || error.code!=='TAKEOVER_REQUIRED')throw error;
      const action=await vscode.window.showWarningMessage('Recover this provider connection?',
        {modal:true,detail:'Its previous editor storage no longer exists. This window can take over the saved connection and its original backup.'},'Recover connection');
      if(action!=='Recover connection')return false;
      return operation({...options,confirmTakeover:true});
    }
  };
  const sameTarget=(a,b)=>a && b && a.provider===b.provider && a.cliPath===b.cliPath &&
    sameProcess(a.process,b.process);
  const safeError=(code,message)=>Object.assign(new Error(message),{code,safeToDisplay:true});
  // ---- the wizard: every cross-user connect and disconnect ----
  // The run binds to the process identity chosen at open (wizard-host.cjs); focus is never read after that (finding 6).
  // wizardState.busy is the only lock and clears on a done screen; cleanup problems are wizard state, never an awaited
  // notification (finding 1).
  const onConnected=async(reportDir,targetProcess,descriptor)=>{
    const managed=new Set(managedDirectories());
    if(!managed.has(reportDir)&&managed.size>=128)throw capacityError();
    managed.add(reportDir);
    await context.globalState.update('managedFeedDirectories',[...managed]);
    pendingCrossUser.set(descriptor.id,{...targetProcess});
    void refresh(true);
  };
  const onDisconnected=async(reportDir,connectionId)=>{
    const managed=new Set(managedDirectories());
    managed.delete(reportDir);
    await context.globalState.update('managedFeedDirectories',[...managed]);
    pendingCrossUser.delete(connectionId);
    void refresh(true);
  };
  const askPassword=async({prompt,error,signal}={})=>{
    if(signal?.aborted)return undefined;
    // The box closes on its own when the run moves on (cancel, session ended) through the token.
    const source=typeof vscode.CancellationTokenSource==='function'?new vscode.CancellationTokenSource():null;
    const abort=()=>source?.cancel();
    signal?.addEventListener?.('abort',abort,{once:true});
    try {
      return await vscode.window.showInputBox({password:true,prompt:error?`${error} ${prompt}`:prompt,ignoreFocusOut:true},source?.token);
    } finally {signal?.removeEventListener?.('abort',abort);source?.dispose?.();}
  };
  const onWizardState=state=>{
    wizardState=state;
    if(closeWanted!==null&&closeWanted===state.runId&&wizard.can.close(state)) {
      // Close was pressed before the bundle cleanup reported; finish it now that it has.
      closeWanted=null;
      void Promise.resolve().then(()=>closeWizard());
    }
    if(state.step==='idle')void refresh(true);
    render();
  };
  try {
    wizardHost=createWizardHost({elevate:createElevate(),sharedFeed,detectProvider,readConnectionFeeds,readFeeds,resolveUser,askPassword,
      extensionPath:context.extensionPath,runtimeVersion,onState:onWizardState,onConnected,onDisconnected});
  } catch {wizardHost=null;}
  const openWizard=options=>{
    if(!wizardHost)throw safeError('WIZARD_UNAVAILABLE','Connecting another account’s session is not available in this editor.');
    if(wizardState.busy)throw safeError('SETUP_IN_PROGRESS','Target-user setup is already in progress in the Account Usage card. Finish or cancel it before starting another.');
    closeWanted=null;
    wizardHost.dispatch({type:'open',...options});
    // The wizard lives in the card; bring it forward when the command came from the palette.
    void Promise.resolve(vscode.commands.executeCommand('llmAccountUsage.usage.focus')).catch(()=>{});
  };
  const closeWizard=()=>{
    if(!wizardHost||!WIZARD_DONE.has(wizardState.step)||wizardState.busy)return;
    if(wizard.can.close(wizardState)){closeWanted=null;wizardHost.dispatch({type:'close'});}
    else closeWanted=wizardState.runId; // cleanup still running: close as soon as it settles
  };
  const commandLines=state=>{
    const preview=state?.preview&&typeof state.preview==='object'?state.preview:{};
    const lines=[
      ...(typeof state?.fallbackCommand==='string'&&state.fallbackCommand?[state.fallbackCommand]:[]),
      ...(Array.isArray(preview.commands)?preview.commands:[]).map(command=>argvLine(command?.argv)),
      ...(Array.isArray(preview.changes)?preview.changes:[]).map(change=>argvLine(change?.argv)||
        (typeof change?.command==='string'&&change.command?change.command:null))];
    return [...new Set(lines.filter(Boolean))];
  };
  const copyCommands=async()=>{
    const lines=commandLines(wizardState);
    if(!lines.length) {await vscode.window.showInformationMessage('There is no command to copy on this screen.');return;}
    try {await vscode.env.clipboard.writeText(lines.join('\n'));}
    catch {await vscode.window.showErrorMessage('The command could not be copied to the clipboard.');return;}
    await vscode.window.showInformationMessage(lines.length===1?'Copied the command.':`Copied ${lines.length} commands.`);
  };
  const wizardIntent=async intent=>{
    if(!WIZARD_INTENTS.has(intent)||!wizardHost)return;
    try {
      if(intent==='copy')return await copyCommands();
      if(intent==='close')return closeWizard();
      wizardHost.dispatch({type:intent});
    } catch(error) {await showSetupError(error);}
  };
  const connect=async(fromCard=false)=>{
    if(process.platform!=='linux') {
      await vscode.window.showInformationMessage('Provider connections currently support Linux terminal hosts.');return;
    }
    const selected=vscode.window.activeTerminal;
    const reconnect=controller.state.needsReconnect?{connection:controller.state.reconnectConnection,target:controller.state.reconnectTarget}:null;
    const matchesReconnect=(current,provider=current?.provider)=>!reconnect || !!(reconnect.connection && reconnect.target &&
      reconnect.connection.provider===reconnect.target.provider && sameProcess(reconnect.target.process,current?.process) &&
      (provider===null || provider===reconnect.target.provider));
    const offered=fromCard?controller.state.setupTarget:null;
    if(fromCard && !offered)return;
    const pid=selected?await selected.processId:null;
    const detected=pid?await detectProvider(pid,{allowForeign:true}):null;
    // Another account's session: the process identity is the binding, never the focused terminal (finding 6).
    const foreign=!!detected && !detected.unavailable && !!detected.process && detected.process.uid!==process.getuid();
    if(!matchesReconnect(detected)) {
      await vscode.window.showInformationMessage('The reconnect session changed. Select its original terminal and try again.');
      await refresh();return;
    }
    if(fromCard && ((!foreign && selected!==vscode.window.activeTerminal) ||
      ((offered.provider!==null || offered.process) && !sameTarget(offered,detected)))) {await refresh();return;}
    await setupReady;
    if(detected?.unavailable) {await showSetupError(safeError('TARGET_UNAVAILABLE','The selected terminal process cannot be verified. Select one live foreground session and connect again.'));return;}
    const choices=[
      {label:'Codex',provider:'codex'},
      {label:'Claude Code',provider:'claude'},
      {label:'Antigravity',provider:'antigravity'}
    ];
    const picked=detected?.provider?detected:await vscode.window.showQuickPick(
      choices,{title:'Connect an account usage provider',placeHolder:'Choose the CLI running in this terminal.'});
    if(!picked)return;
    const connectCurrent=async options=>{
      const currentTarget=detected?await detectProvider(pid):null;
      const currentPid=selected?await selected.processId:null;
      if(selected!==vscode.window.activeTerminal || currentPid!==pid ||
        (detected && !sameTarget(detected,currentTarget)) || !matchesReconnect(currentTarget,picked.provider)) {
        await vscode.window.showInformationMessage('The selected terminal changed. Select its session and connect again.');
        await refresh();return false;
      }
      return setup.connectProvider(options);
    };
    try {
      if(!matchesReconnect(detected,picked.provider))throw safeError('PROVIDER_MISMATCH','Choose the same provider as the profile being reconnected.');
      if(foreign) {
        if(wizardState.busy)throw safeError('SETUP_IN_PROGRESS','Target-user setup is already in progress in the Account Usage card. Finish or cancel it before starting another.');
        const reportDir=reconnect?.connection?.reportDir;
        if(managedDirectories().length>=128 && !managedDirectories().includes(reportDir))throw capacityError();
        openWizard({mode:'connect',target:{...detected,provider:picked.provider},terminalPid:pid,provider:picked.provider,
          connection:reconnect?.connection??null});
        return;
      }
      let profilePath,cliPath=detected?.cliPath;
      while(true) {
        const options={...setupOptions,provider:picked.provider,...(profilePath?{profilePath}:{}),...(cliPath?{cliPath}:{}),
          ...(detected?{pendingProcess:detected.process}:{})};
        let found;
        try {found=await setup.discoverProvider(options);}
        catch(error) {
          const profileMissing=error?.safeToDisplay===true && error.code==='PROFILE_REQUIRED';
          // A script launcher on PATH (an npm install) is as good as missing: offer the picker.
          const executableMissing=error?.safeToDisplay===true && ['CLI_NOT_FOUND','UNSUPPORTED_CLI'].includes(error.code);
          if(!profileMissing && !executableMissing)throw error;
          const action=profileMissing?'Choose profile':'Choose executable';
          if(await vscode.window.showWarningMessage(error.message,action)!==action)return;
          const selected=await vscode.window.showOpenDialog({title:action,
            canSelectFiles:executableMissing,canSelectFolders:profileMissing,canSelectMany:false,
            defaultUri:vscode.Uri.file(os.homedir())});
          if(!selected?.[0])return;
          if(profileMissing)profilePath=selected[0].fsPath;else cliPath=selected[0].fsPath;
          continue;
        }
        const shared=found.sharedDirectories||[];
        const connectAction=shared.length?'Trust and connect':'Connect';
        const trustDetail=shared.length?'\n\nThese local paths have changed since approval, are controlled by another Linux owner, or are writable by a shared group:\n'+
          shared.map(item=>`${item.kind==='executable'?'Executable':'Directory'}: ${item.path} `+
            `(owner UID ${item.uid}, group GID ${item.gid}, mode ${(item.mode&0o7777).toString(8)})`).join('\n')+
          '\n\nContinue only if you trust the listed owners and everyone who can write through these groups. '+
          'This approval is saved on this host; ownership or permission changes require review again.':'';
        const setupDetail=picked.provider==='codex'
          ? (found.hasExistingHooks?'Your existing Codex hooks will be preserved. This adds one Stop hook for account usage.':'This adds one Codex Stop hook for account usage.')
          : (found.hasExistingStatusLine?'Your existing statusline will be preserved.':'This adds a statusline reader for account usage.');
        const action=await vscode.window.showInformationMessage(
          `Connect ${providerName(picked.provider)}?`,
          {modal:true,detail:`Profile: ${found.profilePath}\n${setupDetail}${trustDetail}`},
          connectAction,'Choose another profile');
        if(action==='Choose another profile') {
          const selected=await vscode.window.showOpenDialog({title:'Choose the CLI profile directory',
            canSelectFiles:false,canSelectFolders:true,canSelectMany:false,defaultUri:vscode.Uri.file(os.homedir())});
          if(!selected?.[0])return;
          profilePath=selected[0].fsPath;continue;
        }
        if(action!==connectAction)return;
        const approved=new Map((Array.isArray(setupOptions.trustedDirectories)?setupOptions.trustedDirectories:[]).map(item=>[item.path,item]));
        for(const item of shared)approved.set(item.path,item);
        options.trustedDirectories=[...approved.values()];
        if(await withRecovery(connectCurrent,options)===false)return;
        await context.globalState.update('trustedDirectories',options.trustedDirectories);
        setupOptions.trustedDirectories=options.trustedDirectories;
        await vscode.window.showInformationMessage(`${providerName(picked.provider)} connected. Restart any session that was already open, then finish a turn in it to publish account usage.`);
        await refresh();return;
      }
    } catch(error) {await showSetupError(error);}
  };
  const disconnect=async()=>{
    try {
      await setupReady;
      const connections=[...await setup.listDisconnectConnections(setupOptions),...await managedConnections(true)];
      const items=connections.map(connection=>({label:providerName(connection.provider),
        description:`UID ${connection.uid} · ${connection.profilePath}`,connection}));
      const picked=await vscode.window.showQuickPick(items,
        {title:'Disconnect account usage profile',placeHolder:'Removes Account Usage while preserving the provider configuration it does not own.'});
      if(!picked)return;
      if(picked.connection.uid!==process.getuid()) {
        const selected=vscode.window.activeTerminal,pid=selected?await selected.processId:null,target=pid?await detectProvider(pid,{allowForeign:true}):null;
        if(!target || target.unavailable || (target.provider!==null&&target.provider!==picked.connection.provider) || target.process?.uid!==picked.connection.uid)
          throw safeError('TARGET_REQUIRED','Select a running terminal owned by this profile’s Linux user before disconnecting.');
        openWizard({mode:'disconnect',target:{...target,provider:picked.connection.provider},terminalPid:pid,provider:picked.connection.provider,
          connection:picked.connection});
        return;
      }
      if(await withRecovery(setup.disconnectProvider,{...setupOptions,connectionId:picked.connection.id})===false)return;
      await refresh();
      await vscode.window.showInformationMessage(`${providerName(picked.connection.provider)} disconnected.`);
    } catch(error) {await showSetupError(error);}
  };
  const provider={resolveWebviewView(resolved) {
    view=resolved;
    const media=vscode.Uri.joinPath(context.extensionUri,'media');
    const uri=name=>resolved.webview.asWebviewUri(vscode.Uri.joinPath(media,name)).toString();
    resolved.webview.options={enableScripts:true,enableCommandUris:false,enableForms:false,localResourceRoots:[media]};
    assets={claude:uri('provider-claude.png'),codex:uri('provider-openai.png'),antigravity:uri('provider-antigravity.png')};
    context.subscriptions.push(
      resolved.webview.onDidReceiveMessage(message=>{
        if(message?.type==='ready'){lastContent='';render();}
        else if(message?.type==='connect') {if(!wizardActive())void connect(true);}
        else if(message?.type==='wizard' && typeof message.intent==='string' && WIZARD_INTENTS.has(message.intent))void wizardIntent(message.intent);
      }),
      resolved.onDidChangeVisibility(()=>{if(resolved.visible)void refresh();}),
      resolved.onDidDispose(()=>{if(view===resolved)view=undefined;})
    );
    lastContent=getHtml();
    resolved.webview.html=renderDocument({css:uri('account-usage.css'),script:uri('account-usage.js'),cspSource:resolved.webview.cspSource},lastContent);
    void refresh();
  }};
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('llmAccountUsage.usage',provider),
    vscode.commands.registerCommand('llmAccountUsage.open',async()=>{
      await vscode.commands.executeCommand('llmAccountUsage.usage.focus');
      const {warnings}=await setupReady;
      if(warnings.length)await vscode.window.showWarningMessage('A saved provider connection needs attention. Run Account Usage: Connect Provider.');
    }),
    vscode.commands.registerCommand('llmAccountUsage.connect',()=>connect()),
    vscode.commands.registerCommand('llmAccountUsage.disconnect',disconnect),
    vscode.commands.registerCommand('llmAccountUsage.refresh',()=>refresh()),
    vscode.window.onDidChangeActiveTerminal(()=>refresh()),
    vscode.window.onDidCloseTerminal(()=>refresh()),
    vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('llmAccountUsage'))void refresh();})
  );
  // Read bounded local session data only while visible. Never poll a vendor or a login.
  let polling=false;
  // The poll only reads the card's reports; it never opens or drives the wizard, and it rests while the wizard is shown.
  const timer=setInterval(async()=> {
    if(!view?.visible || polling || wizardActive())return;
    polling=true;try{await refresh(true);}finally{polling=false;}
  },2000);
  let stopping=null;
  const stop=()=>{
    if(!stopping) {
      clearInterval(timer);controller.dispose();
      stopping=Promise.resolve(wizardHost?.dispose?.()).catch(()=>{});
    }
    return stopping;
  };
  stopActive=stop;
  context.subscriptions.push({dispose(){void stop();}});
  void refresh();
  return {getState:()=>controller.state,getRows:()=>buildRows(controller.state),getViewModel,getHtml,refresh:()=>refresh(),
    getWizardState:()=>wizardState,wizardSettled:async()=>{await wizardHost?.settled();return wizardState;}};
}
// Returns the wizard host's dispose promise, so VS Code waits for the fallback's handoff and poll to be gone.
function deactivate() {return stopActive?.();}
module.exports={activate,deactivate};
