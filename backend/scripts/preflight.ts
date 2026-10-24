import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createProviderFromEnv } from '../src/agents/provider.js';
const env=process.env,args=new Set(process.argv.slice(2));
const lock=JSON.parse(readFileSync(new URL('../contract.lock.json',import.meta.url),'utf8'));
const hash=createHash('sha256').update(readFileSync(new URL('../vendor/contract/openapi.json',import.meta.url))).digest('hex');
const modelKeys=['MOTION_LLM_BASE_URL','MOTION_LLM_MODEL','MOTION_LLM_API_KEY'];
const configured=modelKeys.every(k=>!!env[k]);
const report:{[key:string]:unknown}={checkedAt:new Date().toISOString(),node:process.version,contractVersion:lock.contract_version,contractHashMatches:hash===lock.sha256,executionMode:env.MOTION_EXECUTION_MODE??'MOCK',modelConfiguration:modelKeys.every(k=>!env[k])?'ABSENT':configured?'COMPLETE':'INCOMPLETE',modelCall:'NOT_RUN',rpcCall:'NOT_RUN',chainPayment:'NOT_RUN',realLearningEvaluation:'NOT_RUN'};
if(args.has('--check-rpc')){
  try{
    const endpoint=env.BASE_SEPOLIA_RPC_URL??'https://sepolia.base.org';const url=new URL(endpoint);if(url.protocol!=='https:')throw new Error('invalid');
    const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]}),signal:AbortSignal.timeout(15000)});
    const data=await response.json() as {result?:string};report.rpcCall=response.ok&&data.result==='0x14a34'?'BASE_SEPOLIA_CHAIN_ID_VERIFIED':'FAILED_OR_WRONG_CHAIN';
  }catch{report.rpcCall='UNAVAILABLE';}
}
if(args.has('--check-model')){
  if(!configured)report.modelCall='CONFIGURATION_REQUIRED';
  else try{const provider=createProviderFromEnv();const result=await provider.call('threat',{goal:'Configuration probe; no real purchase.',untrustedText:'A normal delivery report.',facts:{externalInstruction:false,externalPaymentPrerequisite:false},defenseConstraints:[]});report.modelCall=result&&['ALLOW','REVIEW','BLOCK'].includes(String(result.verdict))?'COMPATIBLE_JSON_RESPONSE_VERIFIED':'INVALID_ROLE_JSON';}catch{report.modelCall='UNAVAILABLE_OR_RATE_LIMITED';}
}
console.log(JSON.stringify(report,null,2));
if(hash!==lock.sha256||report.modelConfiguration==='INCOMPLETE'||String(report.rpcCall).startsWith('FAILED')||report.rpcCall==='UNAVAILABLE'||['CONFIGURATION_REQUIRED','INVALID_ROLE_JSON','UNAVAILABLE_OR_RATE_LIMITED'].includes(String(report.modelCall)))process.exitCode=1;
