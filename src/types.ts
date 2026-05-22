import type { Event as NostrEvent, Filter as NostrFilter } from 'nostr-tools';

export type RelayUrl = string & { readonly __brand: 'RelayUrl' };

export type Phase = 'idle' | 'collecting' | 'ready' | 'broadcasting';

export type Mode = 'forward' | 'reverse';

export interface Settings {
  mode: Mode;
  sourceRelay: string;
  destinationRelay: string;
  monitorSeeds: string[];
  filterJson: string;
  phase: Phase;
  advanced: AdvancedSettings;
}

export interface AdvancedSettings {
  maxFilterLimit: number;
  dedupeSize: number;
  queueSizePerRelay: number;
  nip11TtlMs: number;
  persistDedupe: boolean;
}

export interface RelayRow {
  url: RelayUrl;
  firstSeen: number;
  lastSeen: number;
  lastOk: number | null;
  failCount: number;
  dead: boolean;
  nip11Json: Nip11Doc | null;
  nip11FetchedAt: number | null;
  // null = unprobed; true = passed viability probe; false = failed (paid, auth-required, unreachable, …)
  viable: boolean | null;
  viableReason: string | null;
  lastProbedAt: number | null;
}

export interface Nip11Doc {
  name?: string;
  limitation?: {
    max_message_length?: number;
    max_subscriptions?: number;
    max_filters?: number;
    max_limit?: number;
    auth_required?: boolean;
    payment_required?: boolean;
  };
}

export interface IngestedEvent {
  id: string;
  parsed: NostrEvent;
  raw: string;
  receivedAt: number;
  sourceRelay?: RelayUrl;
}

export type PublishOutcome =
  | { kind: 'ok' }
  | { kind: 'duplicate' }
  | { kind: 'permanent'; reason: string }
  | { kind: 'transient'; reason: string };

export type RelayMessage =
  | ['EVENT', string, NostrEvent]
  | ['EOSE', string]
  | ['OK', string, boolean, string]
  | ['NOTICE', string]
  | ['CLOSED', string, string]
  | ['AUTH', string];

export type ClientMessage =
  | ['REQ', string, ...NostrFilter[]]
  | ['CLOSE', string]
  | ['EVENT', NostrEvent]
  | ['AUTH', NostrEvent];

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const DEFAULT_MONITOR_SEEDS: readonly string[] = [
  'wss://relay.nostr.watch',
  'wss://history.nostr.watch'
];

export function defaultSettings(): Settings {
  return {
    mode: 'forward',
    sourceRelay: '',
    destinationRelay: '',
    monitorSeeds: [...DEFAULT_MONITOR_SEEDS],
    filterJson: '{\n  "kinds": [1],\n  "limit": 200\n}',
    phase: 'idle',
    advanced: {
      maxFilterLimit: 500,
      dedupeSize: 10_000,
      queueSizePerRelay: 1_000,
      nip11TtlMs: 7 * 86_400 * 1_000,
      persistDedupe: false
    }
  };
}
