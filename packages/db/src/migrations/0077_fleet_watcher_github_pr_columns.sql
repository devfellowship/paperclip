ALTER TABLE issues ADD COLUMN IF NOT EXISTS github_repo TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS github_pr_number INTEGER;
CREATE INDEX IF NOT EXISTS issues_github_pr_idx ON issues (github_repo, github_pr_number);
