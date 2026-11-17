import {spawnSync} from 'node:child_process';
for(const args of [[],['--scale=1.5']]){const result=spawnSync(process.execPath,['scripts/verify-native-workspace.mjs',...args],{windowsHide:true,stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
