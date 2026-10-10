export type Actor =
  | { kind: 'user'; id: number }
  | { kind: 'admin' }
  | { kind: 'anonymous' };

/** Value stored in transfer_status_history.changed_by. */
export const actorLabel = (a: Actor): string =>
  a.kind === 'user' ? `user:${a.id}` : a.kind === 'admin' ? 'admin' : 'system';

export type AccountRow = {
  id: number;
  kind: 'USER_WALLET' | 'SYSTEM';
  user_id: number | null;
  balance: number;
};

export type TransferRow = {
  id: number;
  type: 'TOPUP' | 'PEER_TRANSFER' | 'WITHDRAWAL' | 'FEE' | 'REVERSAL';
  status: 'HELD' | 'COMPLETED' | 'REVERSED' | 'REJECTED';
  amount: number;
  fee: number;
  source_account_id: number;
  destination_account_id: number;
  initiated_by_user_id: number | null;
  reverses_transfer_id: number | null;
  note: string | null;
  created_at: Date;
};

export type EntryRow = {
  id: number;
  transfer_id: number;
  account_id: number;
  direction: 'D' | 'C';
  amount: number;
  created_at: Date;
};

export type Leg = { accountId: number; direction: 'D' | 'C'; amount: number };
