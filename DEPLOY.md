# Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which SSHes into the
Hetzner VPS, resets the checkout to `origin/main`, and runs
`docker compose up -d --build`. If anything under `station/` changed, it also
restarts the `station` container, since the `.scd` files are bind-mounted and
only read when sclang starts.

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
cd ~/generative-station && git pull && docker compose up -d --build
```

## Note for agents

After pushing to `main`, check that the deploy succeeded:

```sh
gh run watch --exit-status
```

A failed deploy leaves the previous containers running; the stream does not
go down because of a failed build.
