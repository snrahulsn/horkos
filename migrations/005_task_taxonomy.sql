-- Comparable analytics require a strict description of the work being compared.
ALTER TABLE oaths
  ADD COLUMN task_type text NOT NULL DEFAULT 'other'
    CHECK (task_type IN ('coding','research','data','content','operations','communication','design','other')),
  ADD COLUMN complexity text NOT NULL DEFAULT 'bounded'
    CHECK (complexity IN ('routine','bounded','complex')),
  ADD COLUMN risk_level text NOT NULL DEFAULT 'medium'
    CHECK (risk_level IN ('low','medium','high','critical')),
  ADD COLUMN deliverable_type text NOT NULL DEFAULT 'other'
    CHECK (deliverable_type IN ('code_change','artifact','report','decision','deployment','data','other')),
  ADD COLUMN required_tools text[] NOT NULL DEFAULT '{}';

CREATE INDEX oaths_taxonomy_idx ON oaths(task_type, complexity, risk_level, deliverable_type);
