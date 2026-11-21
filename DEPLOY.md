# Deployment

Every push runs the `test` job in `.github/workflows/deploy.yml`: shell syntax,
`ci/test-deploy.sh`, and `ci/smoke.sh`, which builds the images on the runner,
starts the whole stack and checks that the piece loads, the stream carries
sound, Caddy serves the right routes and a compound posted to the webhook
reaches SuperCollider.

A push to `main` is then deployed, but only if that job passes: the `deploy`
job SSHes into the Hetzner VPS, resets the checkout to `origin/main`, and runs
`deploy.sh`.

`deploy.sh` only touches what changed since the commit the server was on:

- It rebuilds an image only if that service's directory changed, then runs
  `docker compose up -d`. A commit that changes no service (docs, the web
  page) leaves every container running and the stream uninterrupted.
- It restarts the `station` container if anything under `station/` changed,
  since the `.scd` files are bind-mounted and only read when sclang starts,
  and also if Icecast was replaced, since that drops the encoder's connection.
- It restarts Caddy if the Caddyfile changed.

It then checks the result and fails the run if anything is wrong: after a
station restart it waits (up to two minutes) for the piece to report
`[piece] all elements running` and the encoder to report `[station] streaming`,
it calls the picker's `/health`, and it checks that all four containers are
running. A piece that fails to load therefore fails the deploy instead of
streaming silence unnoticed.

Last, the deploy job runs `ci/check-site.sh` against the live site from the
CI runner: the page, its script and five seconds of the stream must load over
HTTPS, and Icecast's own pages must not be reachable.

Secrets (`.env` with Icecast passwords and the webhook secret) live only on
the server and are never touched by the workflow.

## One-time setup

### On the VPS

Create a dedicated deploy key (run locally, not on the server):

```sh
ssh-keygen -t ed25519 -f gs-deploy -C "generative-station deploy" -N ""
```

Append `gs-deploy.pub` to `~/.ssh/authorized_keys` on the VPS. Optionally
prefix the line with restrictions so the key can only deploy:

```
no-port-forwarding,no-agent-forwarding,no-X11-forwarding <key...>
```

The checkout on the server is assumed to be at `~/generative-station` for the
deploy user, tracking `origin/main`.

### On GitHub

Repo Settings > Secrets and variables > Actions, add:

| Secret           | Value                                  |
| ---------------- | -------------------------------------- |
| `DEPLOY_HOST`    | VPS IP or hostname                     |
| `DEPLOY_USER`    | SSH user that owns the checkout        |
| `DEPLOY_SSH_KEY` | contents of the `gs-deploy` private key |

Then delete the local `gs-deploy` private key file.

The workflows pin two things about the SSH connection:

- The SSH action is pinned to a commit rather than a tag, because it is handed
  the deploy key. To update it, replace the commit in both workflow files with
  the one behind a newer release tag.
- `fingerprint` is the server's ECDSA host key, so the connection fails if
  anything else answers. If the server is rebuilt or its host keys change,
  deploys will fail with "host key fingerprint mismatch" until it is updated
  in both workflow files. Get the new value on the server with
  `ssh-keygen -l -f /etc/ssh/ssh_host_ecdsa_key.pub`.

## Checking on the server

The **Status** workflow (Actions tab, "Run workflow") prints a read-only
report: the deployed commit, host load, memory and disk, container state and
CPU, and what the station has logged since it started (xruns, late bundles,
server failures, errors, compounds, percussion windows), followed by the same
outside check of the live site. The repository is public and so are these
logs, so it prints no environment or access logs.

Icecast's status and admin pages are not on the public site. To see them,
forward its local port and open `http://localhost:8000/admin/`:

```sh
ssh -L 8000:localhost:8000 <user>@<server>
```

## Manual deploy

The workflow can also be run by hand from the Actions tab
(`workflow_dispatch`), or on the server:

```sh
cd ~/generative-station
OLD=$(git rev-parse HEAD) && git pull && ./deploy.sh "$OLD"
```

Run `./deploy.sh` with no argument to rebuild and restart everything.

## Note for agents

After pushing to `main`, check that the run succeeded, tests and deploy both:

```sh
gh run watch --exit-status
```

Push to a branch first to run the tests without deploying. The Status workflow
shows the result on the server afterwards.

A failed build leaves the previous containers running, so the stream does not
go down because of it. A failed health check means the new code is live but
not working: read the log lines the run printed and push a fix (or revert).
