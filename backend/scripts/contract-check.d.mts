import type { TestContext } from 'node:test';
import type { Server } from 'node:http';
import type * as Public from '../src/generated/contracts.js';

export interface Operation { operationId:string; method:string; path:string }
export interface Checker {
  api:Record<string,unknown>; version:string; operations:Operation[];
  schemas:Record<string,unknown>;
  checkSchema(name:string,value:unknown):unknown;
  checkResponse(operationId:string,status:number,headers:Headers|Record<string,string>,body:unknown,options?:{canaries?:string[]}):unknown;
  checkEvent(event:Public.EventEnvelope):Public.EventEnvelope;
}
export interface ResponseMap {
  getCatalog:Public.Catalog;
  createTask:Public.TaskSnapshot;
  getTask:Public.TaskSnapshot;
  planTask:Public.TaskSnapshot;
  getResourcePlan:Public.ResourcePlan;
  authorizeTask:Public.TaskSnapshot;
  runTask:Public.TaskSnapshot;
  cancelTask:Public.TaskSnapshot;
  revokeTaskAuthorization:Public.TaskSnapshot;
  listPayments:Public.PaymentList;
  getPayment:Public.PaymentView;
  getDecision:Public.DecisionView;
  getEvidence:Public.EvidenceSummary;
  getBudget:Public.BudgetView;
  listReviews:Public.ReviewList;
  resolveReview:Public.ResolveReviewResult;
  listLessons:Public.LessonList;
  streamTaskEvents:Public.ApiError;
}
export interface Result<T> {response:Response;data:T}
export type ReadySnapshot=Public.TaskSnapshot&{authorization:NonNullable<Public.TaskSnapshot['authorization']>};
export interface RequestOptions {
  params?:Record<string,string>;body?:unknown;ifMatch?:string;idempotencyKey?:string|null;
  auth?:boolean|string;contractVersion?:string|null;headers?:Record<string,string>;
}
export interface HarnessOptions {
  dbPath?:string;operatorToken?:string;authRequired?:boolean;
  scenario?:'normal'|'blocked'|'review'|'unknown'|'lesson';clock?:()=>Date;
  reviewTtlMs?:number;eventHistoryLimit?:number;testScenarioHeader?:boolean;
}
export interface Diagnostics {closed:boolean;backgroundJobs:number;pendingReviews:number;signerPid?:number}
export interface Harness {
  checker:Checker;token:string;dbPath:string;appOptions:HarnessOptions;observed:Set<string>;
  base:string;app:{server:Server;close():Promise<void>;diagnostics?:Diagnostics|(()=>Diagnostics)};
  request<K extends keyof ResponseMap>(operationId:K,options?:RequestOptions):Promise<Result<ResponseMap[K]>>;
  request(operationId:string,options?:RequestOptions):Promise<Result<unknown>>;
  pollTask(taskId:string,predicate:Public.TaskSnapshot['status']|((task:Public.TaskSnapshot)=>boolean),options?:{timeoutMs?:number}):Promise<Public.TaskSnapshot>;
  createDraft(options?:{scenario?:string;key?:string;overrides?:Partial<Public.CreateTask>}):Promise<Result<Public.TaskSnapshot>&{body:Public.CreateTask;key:string}>;
  readyTask(options?:{scenario?:string}):Promise<{task:ReadySnapshot;plan:Public.ResourcePlan;taskId:string}>;
  startTask(options?:{scenario?:string}):Promise<{task:ReadySnapshot;plan:Public.ResourcePlan;taskId:string;run:Public.TaskSnapshot}>;
  events(taskId:string,seq?:number,options?:{timeoutMs?:number;until?:(event:Public.EventEnvelope,all:Public.EventEnvelope[])=>boolean;auth?:boolean}):Promise<{response?:Response;data?:Public.ApiError;events:Public.EventEnvelope[];aborted?:boolean}>;
  endpoint(operationId:string,params?:Record<string,string>):{operation:Operation;path:string};
  close():Promise<void>;restart():Promise<void>;
}
export function assertPublicOnly(value:unknown,canaries?:string[]):void;
export function assertExposure(budget:Public.BudgetView):void;
export function loadContractChecker():Promise<Checker>;
export function createBackendHarness(t:TestContext,options?:HarnessOptions):Promise<Harness>;
export function errorBody(value:unknown):Public.ApiError;
