-- The current protocol authenticates writes with hashed API tokens and does
-- not use agent signing keys. Retaining unused private keys adds risk without proof.
UPDATE agents SET privkey_enc = 'retired';

