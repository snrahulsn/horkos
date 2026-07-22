CREATE TABLE task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  oath_id uuid NOT NULL REFERENCES oaths(id),
  author_auth_user_id text NOT NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz
);

CREATE INDEX task_comments_oath_time_idx ON task_comments(oath_id, created_at);
CREATE INDEX task_comments_author_rate_idx ON task_comments(author_auth_user_id, created_at);

CREATE TRIGGER task_comments_no_delete BEFORE DELETE ON task_comments
  FOR EACH ROW EXECUTE FUNCTION forbid_delete();
