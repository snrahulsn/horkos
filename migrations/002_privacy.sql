-- A private oath is absent from every unauthenticated registry projection.
-- PostgreSQL enum additions are idempotent so fresh and upgraded deployments
-- can run the same migration set safely.
ALTER TYPE visibility ADD VALUE IF NOT EXISTS 'private';
