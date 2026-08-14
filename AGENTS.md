# Sharedrive delivery policy

Read this file before making changes, commits, or remote Git operations in this repository.

## Development flow

1. Make and validate changes locally in `X:\sharedrive`.
2. Commit only after the user has approved the change set.
3. Push approved commits only to the self-hosted GitLab remote named `gitlab`.
4. The test server deploys from the self-hosted GitLab repository. Perform functional testing there before any promotion.
5. Promotion to GitHub/beta is performed only by the user's explicit GitLab pipeline action.
6. Promotion to `latest` is a separate, user-controlled release action.

## Remote safety

- `gitlab` is the only remote an agent may push to for normal development and test deployment.
- `origin` points to GitHub and must never be pushed to, fetched for deployment, force-pushed, or suggested as a push target by an agent.
- Never run `git push` without an explicit remote and branch. The allowed form is `git push gitlab master` when the user has approved a commit for test deployment.
- Never change remote URLs, upstream tracking, branch protection, CI/CD configuration, or release settings unless the user explicitly requests that exact change.

## Commit policy

- Do not create automatic commits.
- Before committing, show or verify the intended changed files and ensure no unrelated files are included.
- Use a clear commit message describing the approved scope.

## Validation

- Run relevant local checks before the GitLab push.
- Report validation results and known limitations, including anything that requires the test server.
