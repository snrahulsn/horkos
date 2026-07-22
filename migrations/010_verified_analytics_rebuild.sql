-- Drop any aggregates computed before hash-only exclusion and strict
-- proof-gated model attribution. The scheduler rebuilds current windows.
TRUNCATE TABLE rollups;
