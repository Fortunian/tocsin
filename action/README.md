# Tocsin GitHub Action

Checks the lockfiles of a checkout against the Tocsin advisory feed. It fails the job when a dependency has a known advisory, writes a job summary, and on a pull request posts one comment with the fixed version and the upgrade command.

```yaml
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  check:
    runs-on: ubuntu-latest
    steps: [{ uses: actions/checkout@v4 }, { uses: Fortunian/tocsin/action@v1 }]
```

The inputs and the output are in [action.yml](action.yml) and in the main [README](../README.md#in-ci).

## README badge

`https://tocsin.sh/badge/<owner>/<repo>.svg` shows `tocsin | clean` or `tocsin | N affected` from the last result this Action reported for the repository, and `tocsin | unknown` before the first report. Add it to your README:

```markdown
[![tocsin](https://tocsin.sh/badge/<owner>/<repo>.svg)](https://tocsin.sh)
```

The Action sends its result after each check when the job has `id-token: write` and the input `report` is `true` (the default). Run it on `push` to the default branch, so the badge shows that branch:

```yaml
on:
  push:
    branches: [main]
  pull_request:
permissions: { contents: read, pull-requests: write, id-token: write }
jobs:
  check:
    runs-on: ubuntu-latest
    steps: [{ uses: actions/checkout@v4 }, { uses: Fortunian/tocsin/action@v1 }]
```

- The report uses the run's GitHub OIDC token. No API key and no secret are needed. Tocsin takes the repository from the token, so a repository can only report for itself.
- Without `id-token: write` (the default permissions, and pull requests from forks) the Action sends nothing and prints nothing.
- A private repository sends nothing. The badge is for public repositories.
- A failed report is one warning in the job log. It never changes the exit code.
- `?ref=<branch>` on the badge URL shows one branch. The default is the default branch.
- Set `report: false` to send nothing.
