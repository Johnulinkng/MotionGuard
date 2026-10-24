import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent } from 'undici';
import { publicOnlyFetch,resourceFetch,NonPublicAddressError,UnrequestedEncodingError } from '../src/payment/transport-net.js';
test('public resource fetch blocks private literal IPs before undici can bypass DNS',async()=>{
  const resource=publicOnlyFetch();
  try{for(const url of ['https://127.0.0.1/','https://169.254.169.254/','https://10.1.1.1/','https://[::1]/','https://[::ffff:127.0.0.1]/'])await assert.rejects(()=>resource(url),NonPublicAddressError);}
  finally{await resource.close();}
});
test('DNS rebinding/private answers fail before a connection is made',async()=>{
  const resource=publicOnlyFetch(async()=>[{address:'127.0.0.1',family:4}]);
  try{await assert.rejects(()=>resource('https://merchant.example/'),(error:unknown)=>error instanceof Error&&(error.cause instanceof NonPublicAddressError));}
  finally{await resource.close();}
});
test('unrequested response coding is refused before attempting decompression',async()=>{
  const mock=new MockAgent();mock.disableNetConnect();mock.get('https://merchant.example').intercept({path:'/'}).reply(200,'deliberately not valid brotli',{headers:{'content-encoding':'br'}});
  const resource=resourceFetch(()=>mock);
  try{await assert.rejects(()=>resource('https://merchant.example/'),(error:unknown)=>error instanceof Error&&error.cause instanceof UnrequestedEncodingError);mock.assertNoPendingInterceptors();}
  // MockAgent implements close but intentionally leaves Dispatcher.destroy unimplemented.
  finally{await mock.close();}
});
