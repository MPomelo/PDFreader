import {readFileSync,writeFileSync,readdirSync,existsSync,mkdirSync} from 'node:fs';
import {resolve,dirname,join,delimiter} from 'node:path';
import {spawnSync} from 'node:child_process';
const env={...process.env};
const local=resolve('.local/cargo/bin/cargo.exe');
if(existsSync(local)){
  env.CARGO_HOME=resolve('.local/cargo');env.RUSTUP_HOME=resolve('.local/rustup');
  const key=Object.keys(env).find(k=>k.toLowerCase()==='path')||'PATH';
  env[key]=dirname(local)+delimiter+(env[key]||'');
}
let metadata;
if(process.argv[2]) metadata=JSON.parse(readFileSync(process.argv[2],'utf8'));
else {
  const result=spawnSync(existsSync(local)?local:'cargo',['metadata','--manifest-path','src-tauri/Cargo.toml','--locked','--format-version','1','--filter-platform','x86_64-pc-windows-msvc'],{env,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(result.status!==0)throw Error(result.stderr);metadata=JSON.parse(result.stdout);
}
const upstream=resolve('public/licenses/upstream');mkdirSync(upstream,{recursive:true});
const notices=['PDFreader Windows native dependency notices. Includes build-time crates conservatively.\nUnmodified MPL-2.0 components: source is available at the exact versioned crates.io download URLs below.\n'];
const sources=[];
for(const pkg of metadata.packages.filter(p=>p.name!=='pdfreader').sort((a,b)=>(a.name+a.version).localeCompare(b.name+b.version))){
  const dir=dirname(pkg.manifest_path),source=`https://crates.io/api/v1/crates/${pkg.name}/${pkg.version}/download`;
  notices.push(`\n========== ${pkg.name} ${pkg.version} (${pkg.license}) ==========\nSource: ${source}\nRepository: ${pkg.repository||''}\n`);
  const files=readdirSync(dir).filter(name=>/^(licen[cs]e|copying|copyright|notice)([-_.]|$)/i.test(name));
  let count=0;
  for(const file of files){try{notices.push(readFileSync(join(dir,file),'utf8'));count++;}catch{}}
  if(!count){
    const fallback=join(upstream,`${pkg.name}-${pkg.version}.txt`);
    const vcs=JSON.parse(readFileSync(join(dir,'.cargo_vcs_info.json'),'utf8'));
    const repo=pkg.repository.replace(/\.git$/,'').replace('https://github.com/','');
    const url=pkg.name==='selectors'?'https://www.mozilla.org/MPL/2.0/index.txt':`https://raw.githubusercontent.com/${repo}/${vcs.git.sha1}/LICENSE`;
    if(!existsSync(fallback)){
      const response=await fetch(url,{signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error(`Missing ${pkg.name} license: HTTP ${response.status} ${url}`);
      const text=await response.text();if(text.length<200||text.includes('<html'))throw Error('Invalid license response');
      writeFileSync(fallback,text);
    }
    notices.push(readFileSync(fallback,'utf8'));sources.push({name:pkg.name,version:pkg.version,url});
  }
}
writeFileSync('public/licenses/Runtime-Rust-Notices.txt',notices.join('\n'));
writeFileSync(join(upstream,'sources.json'),JSON.stringify(sources,null,2)+'\n');
console.log(`Collected licenses for ${metadata.packages.length-1} pinned native/build dependencies.`);
