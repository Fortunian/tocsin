-- /v1/check matches PyPI and python dependencies by PEP 503 name. OSV stores the
-- package name with its PyPI case (Django, PyYAML), so the candidate query
-- compares a normalized expression of `component`. Additive only: one partial
-- expression index, no new table, no retention rule needed.
-- The expression must stay identical to PYPI_NAME_EXPR in src/check/candidates.ts.
CREATE INDEX IF NOT EXISTS idx_advisories_pypi_name ON advisories (
  replace(replace(replace(replace(replace(replace(lower(trim(component)), '_', '-'), '.', '-'), '--', '-'), '--', '-'), '--', '-'), '--', '-'),
  ecosystem
) WHERE ecosystem IN ('PyPI', 'python');
