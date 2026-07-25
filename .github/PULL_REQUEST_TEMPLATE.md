## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem being solved. Link the issue if there is one: Closes #123 -->

## Type of change

- [ ] Bug fix (non-breaking)
- [ ] New feature (non-breaking)
- [ ] Breaking change
- [ ] Documentation
- [ ] Refactor or internal change

## How this was verified

<!--
Describe what you actually ran, not what you intended to. If you added an
analyzer rule, say which good cases you confirmed it stays quiet on — that is
the half that keeps the tool usable.
-->

- [ ] `pnpm verify` passes (typecheck, lint, tests)
- [ ] `pnpm test:e2e` passes, if the change is user-visible
- [ ] New behaviour has tests
- [ ] A new analyzer rule has both a positive and a negative test

## Trade-offs

<!--
Anything you deliberately chose not to do, or a decision a reviewer might
question. Saying it here is cheaper than having it inferred from the diff.
-->

## Checklist

- [ ] The commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] Documentation is updated if behaviour or configuration changed
- [ ] No credentials, tokens or personal data appear in the diff
- [ ] Analyzers remain pure functions — no network, clock, or shared state
