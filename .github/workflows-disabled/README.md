# .github/workflows-disabled/

GitHub Actions only auto-discovers workflows under `.github/workflows/`. Anything
in this sibling `workflows-disabled/` directory is **not** loaded — it's a
parking lot for workflows we want to keep version-controlled but not active yet.

## Why this exists

The first workflow parked here (`release-plugin-aws.yml`) was authored in PR #36
+ extended in PR #40. The intent was to trigger only on tag pushes matching
`plugin-aws-v*`:

```yaml
on:
  push:
    tags:
      - "plugin-aws-v*"
  workflow_dispatch:
```

But GitHub Actions appears to have been firing it on **every** push (to develop
and to feature branches) regardless of the `tags` filter — every push showed a
red "Release plugin" failure run with 0s duration, spamming notifications. PR
#44 tried two defensive fixes (canonical multiline `tags:` form + job-level
`if:` guard); neither fully suppressed the phantom failures.

Until we're ready to push the first `plugin-aws-v0.1.0` tag (which needs the
`ARC_PUBLISHER_PRIV` repo secret populated), parking the workflow here keeps
the file in source control without GitHub Actions evaluating it.

## How to re-enable

When you're ready to do a real release:

```sh
git mv .github/workflows-disabled/release-plugin-aws.yml .github/workflows/
git commit -m "ops: re-enable release-plugin-aws workflow for first release"
git push
git tag plugin-aws-v0.1.0
git push origin plugin-aws-v0.1.0
```

The workflow will then run on the tag push as intended. If it phantom-triggers
again, the next debugging step is to compare the YAML against GitHub's
[`push.tags` filter docs](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#onpushpull_requestpull_request_targetbranchesignore-branchestags-tags-ignore-tagsignore)
and consider whether the workflow name's em-dash or some YAML quirk is
interfering with trigger evaluation.

## Other workflows that may land here

- Any workflow that should only run on rare events (release tags, scheduled
  monthly maintenance, manual operator commands) but where GitHub Actions
  trigger filtering is unreliable.
- Workflows under active development that aren't ready to run on every commit.
