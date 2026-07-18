ALTER TABLE sync_chunks ADD COLUMN claim_token uuid;

ALTER TABLE sync_account_claims ADD COLUMN claim_token uuid;
