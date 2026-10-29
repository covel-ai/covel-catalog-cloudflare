-- Keep public unauthenticated reads below GitHub's 60/hour allowance while
-- authenticated Actions still shares the global lease and total budget.
ALTER TABLE github_gate ADD COLUMN anonymous_used INTEGER NOT NULL DEFAULT 0;
