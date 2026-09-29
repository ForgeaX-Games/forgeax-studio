import {spawn, spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync, realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';

// Live installed MCP acceptance. No handwritten HTTP or preloaded asset input.
const [cliArg, projectArg, evidenceArg, query] = process.argv.slice(2);
const cli = realpathSync(cliArg), project = realpathSync(projectArg);
const evidence = resolve(evidenceArg); mkdirSync(evidence, {recursive:true});
const child = spawn(process.execPath,[cli,'asset3d','mcp'],{cwd:project,stdio:['pipe','pipe','pipe']});
const pending = new Map(); let id=0, buffer='';
child.stderr.on('data',()=>{}); // never echo credential-bearing upstream diagnostics
child.stdout.on('data',chunk=>{
  buffer+=chunk;
  for (;;) {
    const end=buffer.indexOf('\n'); if(end<0) break;
    const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
    if(!line.trim()) continue;
    const message=JSON.parse(line); pending.get(message.id)?.(message);
  }
});
function rpc(method,params){const requestId=++id;return new Promise((done,reject)=>{
  const timeout=setTimeout(()=>{pending.delete(requestId);reject(Error('MCP timeout: '+method));},150000);
  pending.set(requestId,response=>{clearTimeout(timeout);pending.delete(requestId);response.error?reject(Error(JSON.stringify(response.error))):done(response.result)});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');
});}
function command(args,label){
  const r=spawnSync(process.execPath,[cli,...args],{cwd:project,encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
  writeFileSync(resolve(evidence,label+'.json'),r.stdout,{mode:0o600});
  assert.equal(r.status,0,label+' failed; inspect private evidence');return JSON.parse(r.stdout);
}
try{
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'ea-pack-acceptance',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await rpc('tools/list',{});writeFileSync(resolve(evidence,'tools.json'),JSON.stringify(list,null,2));
  const tool=list.tools.find(t=>t.name==='search_asset');assert(tool,'search_asset unavailable');
  console.log(JSON.stringify(tool.inputSchema));
  if(query){
    const begun=command(['asset3d','begin','--query',query,'--json'],'begin');
    const result=await rpc('tools/call',{name:'search_asset',arguments:{execution:begun.value.execution,queries:[query],output_format:'asset'}});
    writeFileSync(resolve(evidence,'search.json'),JSON.stringify(result,null,2),{mode:0o600});
    assert(!result.isError,'search returned MCP error; inspect private evidence');
    const receipt=JSON.parse(result.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
    console.log(JSON.stringify({search:receipt.results?.map(r=>({status:r.status,format:r.deliveredFormat,id:r.providerAssetId,primaryPack:r.primaryPack,code:r.code}))}));
    assert(receipt.results?.some(r=>r.status==='ok'&&r.deliveredFormat==='pack'),'No Pack returned by real search');
    const committed=command(['asset3d','commit','--execution',begun.value.execution,'--json'],'commit');
    assert(committed.ok,'commit failed');
    console.log(JSON.stringify({commit:committed.value.results.map(r=>({status:r.status,sourcePath:r.sourcePath,rows:r.rows?.filter(a=>a.kind==='scene'||a.kind==='mesh')}))}));
  }
}finally{child.stdin.end();child.kill('SIGTERM');}
