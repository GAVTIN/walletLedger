import type { EntryRow, TransferRow } from '../types';

export const presentTransfer = (t: TransferRow) => ({
  id: t.id,
  type: t.type,
  status: t.status,
  amount: t.amount,
  fee: t.fee,
  source_account_id: t.source_account_id,
  destination_account_id: t.destination_account_id,
  initiated_by_user_id: t.initiated_by_user_id,
  reverses_transfer_id: t.reverses_transfer_id,
  note: t.note,
  created_at: t.created_at,
});

export const presentEntry = (e: EntryRow) => ({
  id: e.id,
  account_id: e.account_id,
  direction: e.direction,
  amount: e.amount,
  created_at: e.created_at,
});
