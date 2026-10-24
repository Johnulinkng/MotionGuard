export const BASE_SEPOLIA_NETWORK = 'eip155:84532' as const;
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;
export const USDC_DOMAIN = { name: 'USDC', version: '2' } as const;
export type Hex = `0x${string}`;
export type ExecutionMode = 'MOCK' | 'TESTNET';
export type PaymentState = 'CREATED' | 'RESERVED' | 'SIGNED' | 'DISPATCHED' | 'SETTLED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN';
export type ResourceKind = 'DOCUMENT' | 'MARKET_DATA' | 'ANALYSIS';
export interface Asset { network: typeof BASE_SEPOLIA_NETWORK; tokenAddress: string; symbol: 'USDC'; decimals: 6 }
export interface Selectors { entityIds?: string[] }
export interface ResourcePlanItem {
  itemId: string; goalStepId: string; resourceKind: ResourceKind; toolId: string; vendorId: string; routeId: string;
  selectors: Selectors; unitPriceCapAtomic: string; maxPaidCalls: number; subtotalCapAtomic: string; dependsOn: string[]; purpose: string;
}
export interface ResourcePlan {
  schemaVersion: '0.1.0'; planId: string; taskId: string; version: number; status: 'DRAFT' | 'FROZEN';
  goalHash: string; catalogVersion: string; planHash: string; items: ResourcePlanItem[]; totalCapAtomic: string; expiresAt: string; createdAt: string;
}
export interface Authorization {
  authorizationId: string; version: number; status: 'ACTIVE' | 'REVOKED'; planHash: string; goalHash: string; catalogVersion: string;
  budgetAtomic: string; maxPaidCalls: number; expiresAt: string; authorizedAt: string; revokedAt: string | null;
}
export interface CatalogVendor {
  vendorId: string; name: string; payTo: string|null; toolId: string; routeId: string; resourceKind: ResourceKind; description: string; toolDescriptorHash: string;
  billing?:{kind:'FREE_PUBLIC_DATA';amountAtomic:'0';requiresPayment:false}; source?:{name:string;url:string;docsUrl:string};
}
export interface TrustedCatalog { schemaVersion: '0.1.0'; catalogVersion: string; asset: Asset; vendors: CatalogVendor[] }
/** Private route registry; never accept these URLs or schema definitions from a model/tool result. */
export interface TrustedRoute {
  vendorId: string; toolId: string; routeId: string; resourceKind: ResourceKind; payTo: string|null; method: 'GET' | 'POST'; url: string;
  toolDescriptorHash: string; bodySchema?: Record<string, unknown>;
}
export interface FrozenAuthorizationInput { taskId: string; plan: ResourcePlan; authorization: Authorization; catalog: TrustedCatalog; routes: TrustedRoute[] }
export interface PaymentIntent {
  taskId: string; planItemId: string; logicalPurchaseId: string;
  vendorId: string; toolId: string; routeId: string; resourceKind: ResourceKind;
  method: 'GET' | 'POST'; selectors?: Selectors; body?: unknown;
  amountAtomic: string; payTo: string; asset: Asset; maxTimeoutSeconds?: number;
  requestHash?: string; offerHash?: string;
}
export interface PreparedPaymentIntent extends PaymentIntent {
  selectors: Selectors; requestHash: string; offerHash: string; maxTimeoutSeconds: number; url: string; intentHash: string;
}
export interface PaymentRecord extends PreparedPaymentIntent {
  paymentId: string; state: PaymentState; executionMode: ExecutionMode; version: number;
  authorizationVersion: number; nonce: Hex | null; validBefore: number | null; signerAddress: Hex | null;
  authorizationHash: Hex | null; transactionHash: Hex | null; reasonCode: string | null;
  createdAt: string; updatedAt: string;
}
export interface Budget {
  schemaVersion: '0.1.0'; taskId: string; asset: Asset; limitAtomic: string; settledAtomic: string;
  reservedAtomic: string; outstandingAtomic: string; availableAtomic: string; version: number;
}
export interface SigningPermit {
  permitId: string; paymentId: string; taskId: string; authorizationVersion: number; requestHash: string; offerHash: string;
  asset: Asset; payTo: Hex; amountAtomic: string; nonce: Hex; validAfter: number; validBefore: number; executionMode: ExecutionMode;
}
export interface SignedMetadata {
  paymentId: string; permitId: string; nonce: Hex; validBefore: number; signerAddress: Hex; authorizationHash: Hex;
}
export interface DispatchCommit extends SignedMetadata { requestHash: string; offerHash: string }
/** The only signer service interface. No generic sign, shell, arbitrary URL, or raw signature method. */
export interface PrivateSigner {
  readonly address: Hex;
  /** Private process diagnostics only; never include in the public HTTP contract. */
  readonly pid?: number;
  signPermit(permit: SigningPermit): Promise<SignedMetadata>;
  settleSandbox(commit: DispatchCommit): Promise<SandboxSettlementProof>;
  payTestnet?(payment: PaymentRecord, hooks: TestnetHandshake): Promise<VerifiedTestnetSettlement>;
  reconcileTestnet?(input:TestnetReconciliation):Promise<VerifiedTestnetSettlement>;
  close(): Promise<void>;
}
export interface AuthorizationCandidate { nonce: Hex; validAfter: number; validBefore: number }
export interface TestnetHandshake {
  beginSigning(candidate: AuthorizationCandidate): Promise<SigningPermit>;
  signed(metadata: SignedMetadata): Promise<void>;
  beforeDispatch(): Promise<DispatchCommit>;
  settlementCandidate(transactionHash:Hex):Promise<void>;
}
export interface TestnetReconciliation{payment:PaymentRecord;permit:SigningPermit;transactionHash:Hex}
export interface VerifiedTestnetSettlement extends SignedMetadata {
  network: typeof BASE_SEPOLIA_NETWORK; asset: Asset; from: Hex; to: Hex; amountAtomic: string;
  transactionHash: Hex; blockNumber: string; confirmations: number; authorizationUsed: true;
}
export interface SandboxSettlementProof extends SignedMetadata {
  cryptographicallyVerified: true; asset: Asset; from: Hex; to: Hex; amountAtomic: string; validAfter: number;
  /** Sandbox evidence identifier, not a blockchain transaction hash. */
  sandboxReceiptId: string;
}
export interface BoundRiskDecision {
  action: 'ALLOW' | 'REVIEW' | 'BLOCK'; taskId: string; requestHash: string; offerHash: string;
  authorizationVersion: number; expiresAt: string;
}
export class PaymentError extends Error {
  constructor(readonly code: string, message: string = code) { super(message); this.name = 'PaymentError'; }
}
