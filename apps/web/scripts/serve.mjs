import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {loadEnvConfig}=require(require.resolve('@next/env',{paths:[dirname(require.resolve('next/package.json'))]}));
loadEnvConfig(process.cwd(),process.argv[2]==='dev');
// Keep discovery alive across Next module reloads and shut it down with the server.
const worker=spawn(process.execPath,['--import','tsx','scripts/catalogue-worker.ts'],{stdio:'inherit'});
const web=spawn(process.execPath,[require.resolve('next/dist/bin/next'),process.argv[2]??'dev','-p',process.env.PORT??'3000'],{stdio:'inherit'});
let stopping=false;
function stop(signal='SIGTERM'){if(stopping)return;stopping=true;worker.kill(signal);web.kill(signal);}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop(signal));
web.on('exit',code=>{stop();process.exitCode=code??0;});
worker.on('exit',code=>{if(code&&!stopping){console.error('Catalogue worker stopped unexpectedly.');stop();process.exitCode=code;}});
