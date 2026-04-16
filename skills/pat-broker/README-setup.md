# pat-broker — one-time setup

The broker mints GitHub **App installation tokens**, which means a GitHub App
has to exist before agents can use the skill. This runbook is for Tainan (or
whoever manages the `devfellowship` org).

## 1. Create the GitHub App

1. Go to <https://github.com/organizations/devfellowship/settings/apps/new>
2. Fill in:
   - **GitHub App name:** `devfellowship-pat-broker`
   - **Homepage URL:** `https://paperclip.devfellowship.com` (or any placeholder)
   - **Webhook:** uncheck "Active" (no webhook needed)
   - **Repository permissions:** grant the full set agents may ever need. The
     App's permissions are the *ceiling*; agents can request *subsets*. Start
     with:
     - Contents: Read & write
     - Pull requests: Read & write
     - Issues: Read & write
     - Actions: Read & write
     - Checks: Read & write
     - Metadata: Read-only (required)
   - **Organization permissions:** leave as "No access" unless you know you need it
   - **Where can this GitHub App be installed?** Only on this account
3. Click **Create GitHub App**
4. On the created App's page:
   - Copy the **App ID** (top of page, e.g. `987654`)
   - Scroll to **Private keys** → **Generate a private key** → download the `.pem` file

## 2. Install the App on the org

1. On the App settings page, sidebar → **Install App**
2. Pick the `devfellowship` org
3. Choose **All repositories** (or select specific ones — agents' `--repo` calls will only work for installed repos)
4. Confirm

## 3. Stash the credentials in Infisical

```bash
# Use infisical CLI, or the UI at https://infisical.devfellowship.com
# personal-vaults-tainan / prod / /shared/
infisical secrets set GITHUB_APP_ID="987654"
infisical secrets set GITHUB_APP_PRIVATE_KEY="$(base64 -w0 < ~/Downloads/devfellowship-pat-broker.*.private-key.pem)"
```

The broker accepts the PEM as either raw text, an absolute file path, or a
single-line base64 blob. Base64 is the safest form to store in Infisical
because it survives copy-paste without mangling the line breaks.

## 4. Create a probe repo (for the negative test)

An empty repo where the negative test can attempt (and fail) a write:

1. <https://github.com/organizations/devfellowship/repositories/new>
2. Name: `pat-broker-probe`
3. Visibility: private
4. Initialize with a README — any seed content is fine
5. Make sure the App is installed on this repo (from step 2 it already is if you chose "All repositories")

## 5. Smoke-test

```bash
# From an agent workspace with the secrets exported:
bash skills/pat-broker/tests/smoke.sh
bash skills/pat-broker/tests/negative-out-of-scope.sh
```

If the negative test prints `PASS: scope attenuation works`, the broker is
live.

## 6. Start using the broker in agents

Agents should stop reading `GITHUB_PAT_BRO` directly. For any GitHub call,
mint a scoped token first:

```bash
export GITHUB_TOKEN=$(bash skills/pat-broker/broker.sh \
  --repo devfellowship/dfl-ci \
  --scopes contents:write,pull_requests:write)
git push origin "feat/DEV-253-pat-broker"
```

## 7. Schedule audit rotation

Add a Paperclip routine (daily) or cron entry that runs
`bash skills/pat-broker/rotate-audit.sh` — this enforces the 1-week retention
required by the acceptance criteria.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `422 permissions … not granted` | Requested a permission you didn't grant the App | Go to App settings → Permissions → add it → accept on install |
| `404` when resolving installation | App not installed on that owner | Install it (step 2) |
| `401 Bad credentials` | Clock skew on adapter host or wrong PEM | Fix `ntp`; re-export `GITHUB_APP_PRIVATE_KEY` |
| Negative test returns 404 not 403 | App installed but `pat-broker-probe` repo missing | Create it (step 4) |
