'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createElevate,resolveUser,USER_PATTERN,SUDO_PATH}=require('../src/elevate.cjs');
const PASSWORD='hunter2-Secret!';
// A recording stand-in for child_process.execFile: argv, options, every stdin chunk, and whether stdin was closed.
function fake(results=[]) {
  const calls=[];
  const execFile=(file,args,options,callback)=>{
    const call={file,args:[...args],options,stdin:[],ended:false};calls.push(call);
    const result=(typeof results==='function'?results(call):results.shift())||{};
    setImmediate(()=>callback(result.error||null,result.stdout||'',result.stderr||''));
    return {stdin:{on(){},write(chunk){call.stdin.push(String(chunk));},end(){call.ended=true;}}};
  };
  return {execFile,calls};
}
const exit=(code,stderr='')=>({error:Object.assign(new Error('Command failed'),{code}),stderr});
const missing=()=>({error:Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'})});
const killed=()=>({error:Object.assign(new Error('timed out'),{code:null,killed:true,signal:'SIGTERM'})});
const safe=code=>error=>error.code===code&&error.safeToDisplay===true&&!error.message.includes(PASSWORD);
const leaks=value=>JSON.stringify(value).includes(PASSWORD);

test('probe runs sudo -n true by absolute path with a 5 s timeout and maps exit 0 to passwordless',async()=>{
  const f=fake([{}]),elevate=createElevate({execFile:f.execFile});
  assert.equal(await elevate.probe(),'passwordless');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].file,'/usr/bin/sudo');assert.equal(SUDO_PATH,'/usr/bin/sudo');
  assert.deepEqual(f.calls[0].args,['-n','true']);
  assert.equal(f.calls[0].options.timeout,5000);assert.equal(f.calls[0].options.maxBuffer,64*1024);
  assert.equal(f.calls[0].options.shell,undefined);assert.equal(f.calls[0].options.env.LC_ALL,'C');
  assert.deepEqual(f.calls[0].stdin,[]);assert.equal(f.calls[0].ended,true);
});

test('probe maps "a password is required" to password and every other failure to none, ENOENT included',async()=>{
  const cases=[[exit(1,'sudo: a password is required\n'),'password'],[exit(1,'sudo: A Password Is Required'),'password'],
    [missing(),'none'],[exit(1,'claudebwai is not in the sudoers file.\n'),'none'],
    [exit(1,'Sorry, user claudebwai may not run sudo on host.\n'),'none'],[exit(1,''),'none'],[killed(),'none']];
  for(const [result,expected] of cases)assert.equal(await createElevate({execFile:fake([result]).execFile}).probe(),expected,JSON.stringify(result.stderr));
});

test('checkPassword runs sudo -S -k -p "" -v with the password only on stdin and resolves true or false',async()=>{
  const f=fake([{},exit(1,'Sorry, try again.\nsudo: 1 incorrect password attempt\n')]),elevate=createElevate({execFile:f.execFile});
  assert.equal(await elevate.checkPassword(PASSWORD),true);
  assert.equal(await elevate.checkPassword(PASSWORD),false);
  for(const call of f.calls) {
    assert.deepEqual(call.args,['-S','-k','-p','','-v']);assert.deepEqual(call.stdin,[PASSWORD+'\n']);assert.equal(call.ended,true);
    assert.equal(leaks([call.file,call.args,call.options]),false,'the password never reaches argv or options');
  }
});

test('checkPassword surfaces a missing sudo or a timeout as a safe error, never as a wrong password',async()=>{
  await assert.rejects(createElevate({execFile:fake([missing()]).execFile}).checkPassword(PASSWORD),safe('SUDO_UNAVAILABLE'));
  await assert.rejects(createElevate({execFile:fake([killed()]).execFile}).checkPassword(PASSWORD),safe('SUDO_TIMEOUT'));
});

test('a password with a line break is refused before sudo runs, so it cannot spill into the command',async()=>{
  const f=fake(),elevate=createElevate({execFile:f.execFile});
  for(const bad of ['a\nb','a\rb','a\0b',42,undefined])await assert.rejects(elevate.checkPassword(bad),safe('INVALID_PASSWORD'));
  await assert.rejects(elevate.run(['/usr/bin/true'],{password:'x\ny'}),safe('INVALID_PASSWORD'));
  assert.equal(f.calls.length,0);
});

test('run without a password uses -n, as root when asUser is absent, and puts -- before the command',async()=>{
  const f=fake([{stdout:'ok\n'}]),elevate=createElevate({execFile:f.execFile});
  const argv=['/usr/bin/install','-d','-m','0755','/var/lib/llm-account-usage'];
  assert.deepEqual(await elevate.run(argv),{code:0,stdout:'ok\n',stderr:''});
  assert.deepEqual(f.calls[0].args,['-n','--',...argv]);
  assert.equal(f.calls[0].args.includes('-k'),false);assert.equal(f.calls[0].args.includes('-S'),false);
  assert.equal(f.calls[0].options.maxBuffer,64*1024);assert.equal(f.calls[0].options.timeout,60000);
  assert.equal(f.calls[0].options.shell,undefined);assert.equal(f.calls[0].ended,true);assert.deepEqual(f.calls[0].stdin,[]);
});

test('run as another account adds -H -u <user> before the -- separator; a dash-led argument stays behind it',async()=>{
  const f=fake([{},{}]),elevate=createElevate({execFile:f.execFile});
  await elevate.run(['/usr/bin/node','/b/src/setup-cli.cjs','discover','--result','-'],{asUser:'claudebwai',input:'{"a":1}',timeoutMs:9000});
  assert.deepEqual(f.calls[0].args,['-n','-H','-u','claudebwai','--','/usr/bin/node','/b/src/setup-cli.cjs','discover','--result','-']);
  assert.deepEqual(f.calls[0].stdin,['{"a":1}']);assert.equal(f.calls[0].options.timeout,9000);
  await elevate.run(['/usr/bin/rmdir','-u','--','/x'],{asUser:'_svc-1'});
  const args=f.calls[1].args,separator=args.indexOf('--');
  assert.deepEqual(args.slice(0,separator),['-n','-H','-u','_svc-1']);assert.deepEqual(args.slice(separator+1),['/usr/bin/rmdir','-u','--','/x']);
});

test('run with a password uses -S -p "" and writes the password line first, then the input, on stdin only',async()=>{
  const f=fake([{stdout:'{"ok":true}\n'}]),elevate=createElevate({execFile:f.execFile});
  const result=await elevate.run(['/usr/bin/node','/b/src/setup-cli.cjs','connect'],{asUser:'claudebwai',password:PASSWORD,input:'payload\n'});
  const {args,stdin,options}=f.calls[0];
  assert.deepEqual(args.slice(0,4),['-S','-k','-p','']);assert.equal(args.includes('-n'),false);
  assert.deepEqual(args.slice(4),['-H','-u','claudebwai','--','/usr/bin/node','/b/src/setup-cli.cjs','connect']);
  assert.deepEqual(stdin,[PASSWORD+'\n','payload\n']);assert.equal(f.calls[0].ended,true);
  assert.equal(leaks([args,options]),false,'the password never reaches argv or options');
  assert.equal(leaks(result),false,'the password is not on the returned object');
  assert.deepEqual(result,{code:0,stdout:'{"ok":true}\n',stderr:''});
});

test('a non-zero exit is returned as a code, not thrown',async()=>{
  const f=fake([{...exit(3,'boom\n'),stdout:'partial'}]);
  assert.deepEqual(await createElevate({execFile:f.execFile}).run(['/usr/bin/false']),{code:3,stdout:'partial',stderr:'boom\n'});
});

test('asUser must match the account-name rule; null or empty never falls back to root; nothing runs on refusal',async()=>{
  const f=fake(),elevate=createElevate({execFile:f.execFile});
  for(const bad of ['root; rm -rf /','Claude','1abc','a'.repeat(33),'','-u','../x','user name','user\n',null,0,{}])
    await assert.rejects(elevate.run(['/usr/bin/true'],{asUser:bad}),safe('INVALID_USER'),JSON.stringify(bad));
  assert.equal(f.calls.length,0);
  for(const good of ['_svc','a-b_c','a'.repeat(32),'claudebwai'])assert.match(good,USER_PATTERN);
});

test('argv must be an array whose first element is an absolute path; bad argv and timeouts are refused before sudo',async()=>{
  const f=fake(),elevate=createElevate({execFile:f.execFile});
  for(const bad of [[],['node','x'],['./setup'],['/usr/bin/../bin/rm'],'/usr/bin/true',[42],['/usr/bin/echo','a\0b'],[`/bin/x\n`],Array(65).fill('/usr/bin/true')])
    await assert.rejects(elevate.run(bad),safe('INVALID_COMMAND'),JSON.stringify(bad));
  for(const timeoutMs of [0,-1,1.5,600001,'60'])await assert.rejects(elevate.run(['/usr/bin/true'],{timeoutMs}),safe('INVALID_TIMEOUT'));
  await assert.rejects(elevate.run(['/usr/bin/true'],{input:{a:1}}),safe('INVALID_INPUT'));
  assert.equal(f.calls.length,0);
  assert.throws(()=>createElevate({execFile:f.execFile,sudoPath:'sudo'}),safe('INVALID_SUDO'));
});

test('run maps a missing sudo, a timeout and oversized output to safe errors that carry no password',async()=>{
  const oversized={error:Object.assign(new Error('stdout maxBuffer length exceeded'),{code:'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',killed:true})};
  for(const [result,code] of [[missing(),'SUDO_UNAVAILABLE'],[killed(),'SUDO_TIMEOUT'],[oversized,'SUDO_OUTPUT_TOO_LARGE'],
    [{error:Object.assign(new Error('signal'),{code:null,signal:'SIGKILL'})},'SUDO_FAILED']])
    await assert.rejects(createElevate({execFile:fake([result]).execFile}).run(['/usr/bin/true'],{password:PASSWORD}),safe(code));
  const throwing=()=>{throw Object.assign(new Error(`bad ${PASSWORD}`),{code:'ERR_INVALID_ARG_VALUE'});};
  await assert.rejects(createElevate({execFile:throwing}).run(['/usr/bin/true'],{password:PASSWORD}),safe('SUDO_FAILED'));
});

test('the wrapper keeps no password: a frozen object of three functions, and nothing is logged',async t=>{
  const logged=[];
  for(const name of ['log','error','warn','info','debug']) {const original=console[name];console[name]=(...a)=>logged.push(a);t.after(()=>{console[name]=original;});}
  const f=fake(()=>({})),elevate=createElevate({execFile:f.execFile});
  await elevate.checkPassword(PASSWORD);await elevate.run(['/usr/bin/true'],{password:PASSWORD,asUser:'claudebwai'});
  await assert.rejects(elevate.run(['/usr/bin/true'],{password:PASSWORD,asUser:'Bad User'}));
  assert.deepEqual(Object.keys(elevate).sort(),['checkPassword','probe','run']);assert.equal(Object.isFrozen(elevate),true);
  assert.equal(Object.values(elevate).every(value=>typeof value==='function'),true);
  assert.deepEqual(logged,[]);
});

test('resolveUser runs /usr/bin/getent passwd <uid> and returns field 1',async()=>{
  const f=fake([{stdout:'claudebwai:x:1053:1053:Claude BWAI,,,:/home/claudebwai:/bin/bash\n'}]);
  assert.equal(await resolveUser(1053,{execFile:f.execFile}),'claudebwai');
  assert.equal(f.calls[0].file,'/usr/bin/getent');assert.deepEqual(f.calls[0].args,['passwd','1053']);assert.equal(f.calls[0].options.shell,undefined);
});

test('resolveUser refuses a bad uid, an unknown uid, a mismatched entry, and any name outside the rule',async()=>{
  const f=fake();
  for(const uid of [-1,1.5,'1053',null,2**32])await assert.rejects(resolveUser(uid,{execFile:f.execFile}),safe('INVALID_USER'));
  assert.equal(f.calls.length,0);
  await assert.rejects(resolveUser(4242,{execFile:fake([exit(2)]).execFile}),safe('USER_NOT_FOUND'));
  await assert.rejects(resolveUser(4242,{execFile:fake([missing()]).execFile}),safe('USER_UNRESOLVED'));
  for(const stdout of ['Bad.Name:x:4242:4242::/h:/bin/sh\n','0root:x:4242:4242::/h:/bin/sh\n','other:x:4243:4243::/h:/bin/sh\n',
    'a:x:4242:4242::/h:/bin/sh\nb:x:4242:4242::/h:/bin/sh\n','short:x:4242\n','','-u:x:4242:4242::/h:/bin/sh\n'])
    await assert.rejects(resolveUser(4242,{execFile:fake([{stdout}]).execFile}),safe('INVALID_USER'),JSON.stringify(stdout));
});

test('with the real execFile and a stand-in for sudo, stdin arrives in order and is closed so the command ends',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'elevate-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const script=async(name,body)=>{const file=path.join(root,name);await fs.writeFile(file,`#!/bin/sh\n${body}\n`,{mode:0o755});return file;};
  // The stand-in prints its argv one per line, a marker, then everything on stdin (cat returns only when stdin closes).
  const echo=await script('echo-sudo',`printf '%s\\n' "$@"; printf '%s\\n' '--stdin--'; cat`);
  const result=await createElevate({sudoPath:echo}).run(['/usr/bin/true','x'],{asUser:'claudebwai',password:PASSWORD,input:'line two\n',timeoutMs:5000});
  assert.equal(result.code,0);
  assert.equal(result.stdout,['-S','-k','-p','','-H','-u','claudebwai','--','/usr/bin/true','x','--stdin--',PASSWORD,'line two',''].join('\n'));
  const plain=await createElevate({sudoPath:echo}).run(['/usr/bin/true'],{timeoutMs:5000});
  assert.equal(plain.stdout,'-n\n--\n/usr/bin/true\n--stdin--\n');
  const asking=await script('asking-sudo',`echo 'sudo: a password is required' >&2; exit 1`);
  assert.equal(await createElevate({sudoPath:asking}).probe(),'password');
  const sleeper=await script('slow-sudo','sleep 5');
  await assert.rejects(createElevate({sudoPath:sleeper}).run(['/usr/bin/true'],{timeoutMs:200}),safe('SUDO_TIMEOUT'));
  const loud=await script('loud-sudo',`head -c 70000 /dev/zero`);
  await assert.rejects(createElevate({sudoPath:loud}).run(['/usr/bin/true']),safe('SUDO_OUTPUT_TOO_LARGE'));
  const absent=path.join(root,'no-such-dir','sudo');
  assert.equal(await createElevate({sudoPath:absent}).probe(),'none');
  await assert.rejects(createElevate({sudoPath:absent}).run(['/usr/bin/true'],{password:PASSWORD}),safe('SUDO_UNAVAILABLE'));
  await assert.rejects(createElevate({sudoPath:absent}).checkPassword(PASSWORD),safe('SUDO_UNAVAILABLE'));
});

test('resolveUser with the real getent returns this process account name',{skip:!USER_PATTERN.test(os.userInfo().username)},async()=>{
  assert.equal(await resolveUser(process.getuid()),os.userInfo().username);
});
