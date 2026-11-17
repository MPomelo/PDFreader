import {execFileSync} from 'node:child_process';
import {readFileSync,statSync} from 'node:fs';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
const errors=[];
const patterns=[/gh[pousr]_[A-Za-z0-9]{30,}/g,/github_pat_[A-Za-z0-9_]{30,}/g,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,/\bsk-[A-Za-z0-9]{24,}/g];
for(const file of files){
  if(/^(?:\.local|node_modules|dist|test-results|release)\//.test(file)||/\.(?:env|pfx|p12|pem)$/.test(file))errors.push({file,reason:'private/generated path'});
  if(statSync(file).size>95*1024*1024)errors.push({file,reason:'exceeds source file size limit'});
  if(/\.(?:pdf|png|ico|woff2?|ttf|bcmap|pfb|wasm)$/.test(file))continue;
  const data=readFileSync(file,'utf8');
  for(const pattern of patterns){pattern.lastIndex=0;if(pattern.test(data))errors.push({file,reason:'possible credential; inspect without printing value'});}
}
if(errors.length){console.error(JSON.stringify(errors,null,2));process.exit(1);}
console.log(`Public source check passed: ${files.length} tracked files; no excluded local data or credential signatures.`);
