ALTER TABLE oaths ADD COLUMN task_title text;

UPDATE oaths
SET task_title = left(regexp_replace(coalesce(goal, domain), '\s+', ' ', 'g'), 160)
WHERE task_title IS NULL;

ALTER TABLE oaths ALTER COLUMN task_title SET NOT NULL;
ALTER TABLE oaths ADD CONSTRAINT oaths_task_title_length CHECK (char_length(task_title) BETWEEN 3 AND 160);

CREATE INDEX oaths_public_search_idx ON oaths
USING gin (to_tsvector('english', task_title || ' ' || domain))
WHERE visibility = 'public';
