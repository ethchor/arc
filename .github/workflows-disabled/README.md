# .github/workflows-disabled/

GitHub Actions only auto-discovers workflows under `.github/workflows/`. Anything
in this sibling `workflows-disabled/` directory is **not** loaded — it's a
parking lot for workflows we want version-controlled but not active.

## Root cause of the phantom failures (solved)

`release-plugin-aws.yml` (added in PR #36, extended in PR #40) produced a red
**instant-failure run on every push** to every branch — 0s duration, zero jobs —
despite its trigger being tags-only:

```yaml
on:
  push:
    tags:
      - "plugin-aws-v*"
```

The cause was **not** the trigger. The file contained a step name with an
unquoted `colon + space` inside a plain YAML scalar:

```yaml
- name: Self-verify (sanity: would arc-server accept this manifest?)
#                           ^ YAML parse error: "mapping values are not allowed here"
```

That makes the whole file unparseable. When a workflow file can't be parsed,
GitHub Actions cannot evaluate its triggers — so it surfaces the parse failure
as a failed workflow run **on every push**, attributed to whatever commit was
pushed. This is why:

- the `tags:` filter appeared to be ignored,
- a job-level `if:` guard (tried in PR #44) changed nothing (the file never
  parsed far enough to evaluate it),
- the runs always showed 0s duration with no jobs,
- the other tag-triggered workflows (`release.yml`, `publish-sdk.yml`) never
  phantom-fired — their YAML is valid.

The step name is fixed in the copy parked here (now
`Self-verify the signed manifest (as arc-server would)` — no bare colon), and
the file validates:

```sh
python3 -c "import yaml; yaml.safe_load(open('.github/workflows-disabled/release-plugin-aws.yml'))"
```

## Why it stays parked anyway

The workflow only has work to do when a `plugin-aws-v*` tag is pushed, and the
first real release also needs the `ARC_PUBLISHER_PRIV` repo secret populated.
Keeping the file out of `.github/workflows/` until then guarantees zero noise
regardless of any future YAML mishap, and re-enabling is one `git mv`.

## How to re-enable (first real release)

```sh
# 1. Validate before you move it — refuse to enable a file that doesn't parse:
python3 -c "import yaml; yaml.safe_load(open('.github/workflows-disabled/release-plugin-aws.yml'))" && echo OK

# 2. Move it back into the auto-discovered directory:
git mv .github/workflows-disabled/release-plugin-aws.yml .github/workflows/
git commit -m "ops: re-enable release-plugin-aws workflow for first release"
git push

# 3. Populate the ARC_PUBLISHER_PRIV repo secret (arc-plugin-sign keygen), then:
git tag plugin-aws-v0.1.0
git push origin plugin-aws-v0.1.0
```

The tag push triggers the release workflow; ordinary branch pushes will not
(valid YAML + tags-only trigger — confirmed working by `release.yml` /
`publish-sdk.yml`, which share the same trigger shape and have never
phantom-fired).

## Lint rule of thumb for all workflows

Keep workflow **step names free of unquoted `: `** (colon+space) — quote the
whole name or rephrase. Validate any edited workflow file locally before
pushing:

```sh
for f in .github/workflows/*.yml; do
  python3 -c "import yaml,sys; yaml.safe_load(open('$f'))" || echo "BROKEN: $f"
done
```
