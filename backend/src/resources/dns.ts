import { z } from 'zod';
import { isPublicAddress,publicOnlyFetch,type Resolver } from '../payment/transport-net.js';
import { readLimited } from '../payment/transport-body.js';
import { ResourceError } from './types.js';

const HOSTS=new Set(['sepolia.base.org','coins.llama.fi','api.llama.fi']);
const DnsJson=z.looseObject({Status:z.literal(0),Answer:z.array(z.looseObject({type:z.number().int(),TTL:z.number().int().nonnegative(),data:z.string().max(1024)})).max(64)});
/** Bootstrap is the fixed public TLS IP 1.1.1.1. Neither origin nor query name comes from a model. */
export function createAllowlistedPublicResolver(options:{fetch?:typeof fetch;timeoutMs?:number}={}):Resolver{
  const cache=new Map<string,{until:number;addresses:{address:string;family:number}[]}>();
  return async hostname=>{
    if(!HOSTS.has(hostname))throw new ResourceError('DNS_HOST_NOT_ALLOWLISTED');
    const known=cache.get(hostname);if(known&&known.until>Date.now())return known.addresses;
    const bootstrap=options.fetch?undefined:publicOnlyFetch();const fetcher=options.fetch??bootstrap!;
    const signal=AbortSignal.timeout(options.timeoutMs??6000);
    try{
      const response=await fetcher(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`,{headers:{accept:'application/dns-json'},redirect:'manual',signal});
      if(response.status!==200||response.redirected){await response.body?.cancel();throw new ResourceError('PUBLIC_DNS_UNAVAILABLE');}
      const type=response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();if(!['application/dns-json','application/json'].includes(type??'')){await response.body?.cancel();throw new ResourceError('PUBLIC_DNS_SCHEMA_INVALID');}
      const read=await readLimited(response,16*1024,signal);if(read.overflow||read.failed||read.stopped)throw new ResourceError('PUBLIC_DNS_RESPONSE_INVALID');
      let raw:unknown;try{raw=JSON.parse(read.data.toString('utf8'));}catch{throw new ResourceError('PUBLIC_DNS_SCHEMA_INVALID');}
      const parsed=DnsJson.safeParse(raw);if(!parsed.success)throw new ResourceError('PUBLIC_DNS_SCHEMA_INVALID');
      const records=parsed.data.Answer.filter(record=>record.type===1);
      if(!records.length||records.some(record=>!isPublicAddress(record.data)||record.data.includes(':')))throw new ResourceError('PUBLIC_DNS_NONPUBLIC_ANSWER');
      const addresses=[...new Set(records.map(record=>record.data))].map(address=>({address,family:4}));
      const ttl=Math.min(300,...records.map(record=>record.TTL));cache.set(hostname,{until:Date.now()+ttl*1000,addresses});return addresses;
    }catch(error){if(error instanceof ResourceError)throw error;throw new ResourceError('PUBLIC_DNS_UNAVAILABLE');}
    finally{await bootstrap?.close();}
  };
}
