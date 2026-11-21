# Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which SSHes into the
Hetzner VPS, resets the checkout to `origin/main`, and runs `deploy.sh`.

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

## Manual deploy

The workflow can also be run by hand from the Actions tab
(`workflow_dispatch`), or on the server:

```sh
cd ~/generative-station
OLD=$(git rev-parse HEAD) && git pull && ./deploy.sh "$OLD"
```

Run `./deploy.sh` with no argument to rebuild and restart everything.

## Note for agents

After pushing to `main`, check that the deploy succeeded:

```sh
gh run watch --exit-status
```

A failed build leaves the previous containers running, so the stream does not
go down because of it. A failed health check means the new code is live but
not working: read the log lines the run printed and push a fix (or revert).
