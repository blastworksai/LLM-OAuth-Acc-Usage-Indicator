'use strict';
const vscode=require('vscode');
const path=require('node:path');
const os=require('node:os');
const {readFeeds,matchReports,buildRows,SelectionController}=require('./core.cjs');
const {detectProvider}=require('./provider.cjs');
const {connectionForTarget,sameProcess}=require('./connection.cjs');
const {buildViewModel,renderContent,renderDocument}=require('./panel.cjs');
const setup=require('./setup.cjs');

function activate(context) {
  let view, assets={}, lastContent='';
  const setupOptions={storagePath:context.globalStorageUri.fsPath,nodePath:process.execPath,
    collectorPath:path.join(context.extensionPath,'collectors','passive.cjs'),
    trustedDirectories:context.globalState.get('trustedDirectories',[])};
  const setupReady=process.platform==='linux'
    ? setup.refreshRuntime(setupOptions).catch(()=>({warnings:['Saved provider connections need attention. Run Account Usage: Connect Provider.']}))
    : Promise.resolve({warnings:[]});
  const getViewModel=()=>buildViewModel(controller.state);
  const getHtml=()=>renderContent(getViewModel(),assets);
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
    const connections=await setup.listConnections(setupOptions).catch(()=>[]);
    const dirs=[...connections.map(connection=>connection.reportDir),
      ...vscode.workspace.getConfiguration('llmAccountUsage').get('feedDirectories',[])];
    const {reports,rejected}=await readFeeds(dirs);
    const result=await matchReports(pid,reports);
    if(result.status==='unavailable' && rejected)result.reason='No matching readable report. A report directory is missing, unreadable or unsafe.';
    if(result.status==='unavailable') {
      const target=await detectProvider(pid);
      const connection=connectionForTarget(connections,target);
      if(target&&!connection)result.setupTarget=target;
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
  const connect=async(fromCard=false)=>{
    if(process.platform!=='linux') {
      await vscode.window.showInformationMessage('Provider connections currently support Linux terminal hosts.');return;
    }
    const selected=vscode.window.activeTerminal;
    const offered=fromCard?controller.state.setupTarget:null;
    if(fromCard && !offered)return;
    const pid=selected?await selected.processId:null;
    const detected=pid?await detectProvider(pid):null;
    if(fromCard && (selected!==vscode.window.activeTerminal ||
      (offered.provider!==null && !sameTarget(offered,detected)))) {await refresh();return;}
    await setupReady;
    const choices=[
      {label:'Codex',provider:'codex'},
      {label:'Claude Code',provider:'claude'},
      {label:'Antigravity',provider:'antigravity'}
    ];
    const picked=detected || await vscode.window.showQuickPick(
      choices,{title:'Connect an account usage provider',placeHolder:'Choose the CLI running in this terminal.'});
    if(!picked)return;
    const connectCurrent=async options=>{
      const currentTarget=detected?await detectProvider(pid):null;
      const currentPid=selected?await selected.processId:null;
      if(selected!==vscode.window.activeTerminal || currentPid!==pid ||
        (detected && !sameTarget(detected,currentTarget))) {
        await vscode.window.showInformationMessage('The selected terminal changed. Select its session and connect again.');
        await refresh();return false;
      }
      return setup.connectProvider(options);
    };
    try {
      let profilePath,cliPath=detected?.cliPath;
      while(true) {
        const options={...setupOptions,provider:picked.provider,...(profilePath?{profilePath}:{}),...(cliPath?{cliPath}:{}),
          ...(detected?{pendingProcess:detected.process}:{})};
        let found;
        try {found=await setup.discoverProvider(options);}
        catch(error) {
          const profileMissing=error?.safeToDisplay===true && error.code==='PROFILE_REQUIRED';
          const executableMissing=error?.safeToDisplay===true && error.code==='CLI_NOT_FOUND';
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
        await vscode.window.showInformationMessage(`${providerName(picked.provider)} connected. Select its terminal and finish a fresh turn to publish account usage.`);
        await refresh();return;
      }
    } catch(error) {await showSetupError(error);}
  };
  const disconnect=async()=>{
    try {
      await setupReady;
      const connections=await setup.listDisconnectConnections(setupOptions);
      const items=connections.map(connection=>({label:providerName(connection.provider),
        description:`UID ${connection.uid} · ${connection.profilePath}`,connection}));
      const picked=await vscode.window.showQuickPick(items,
        {title:'Disconnect account usage profile',placeHolder:'Removes Account Usage while preserving the provider configuration it does not own.'});
      if(!picked)return;
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
        else if(message?.type==='connect')void connect(true);
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
  const timer=setInterval(async()=> {
    if(!view?.visible || polling)return;
    polling=true;try{await refresh(true);}finally{polling=false;}
  },2000);
  context.subscriptions.push({dispose(){clearInterval(timer);controller.dispose();}});
  void refresh();
  return {getState:()=>controller.state,getRows:()=>buildRows(controller.state),getViewModel,getHtml,refresh:()=>refresh()};
}
module.exports={activate};
