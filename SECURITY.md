# Security Policy

## Threat model

applyd is a personal-use Claude Code skill bundle. It runs locally on the user's machine, reads the user's own configuration files, and calls third-party APIs the user explicitly configured (Notion, Bright Data, Greenhouse, Ashby, Lever, Workable). It does **not** expose a network listener, **not** accept untrusted input, and **not** run as a multi-user service. Sensitive data (Notion token, Bright Data API key) lives in a gitignored `.env` file in the user's workspace and never enters the repository.

Business criticality: **low**. There is no production deployment to attack.

## Security baseline (commit 8d110e9)

Three independent scans against the marketplace release commit:

| Scan | Tool | Candidates | Confirmed | False positives |
|---|---|---|---|---|
| Dependencies (SCA) | Wraith / OSV-Scanner v2.0.2 | 40 | 0 | 40 (Go stdlib advisories not reachable in the TUI) |
| Secrets | Poltergeist v2.0.5 | 20 | 0 | 20 (all inside `node_modules/`) |
| Code (SAST) | Ghost AI SAST | 18 files | 0 | — |

Full reports live in this repository's release notes for the corresponding tag.

## Ongoing security gates

These run automatically on every push / PR:

- `.github/workflows/test.yml` — 97 internal smoke checks (JS syntax, YAML lint, JSON lint, SKILL.md frontmatter validity, required engine files, user-layer file leak detection, credential scanning for `ntn_*` / `sk-*` / `ghp_*` / Bright Data sentinel, absolute-path detection, liveness classifier, location filter, mode-file integrity).
- `.github/workflows/codeql.yml` — CodeQL static analysis on Node sources.
- `.github/workflows/dependency-review.yml` — dependency-graph diff on every PR.
- `.github/dependabot.yml` — weekly automated dependency PRs for npm (`/`), gomod (`/dashboard`), and github-actions (`/`).

## Third-party licence boundaries

applyd is MIT-licensed. It integrates with third-party services whose code never enters this repository — they run in separate processes and we talk to them over HTTP / their MCP. The most important boundary to call out:

**Firecrawl (AGPL-3.0).** If the user opts into the self-hosted path, the install script clones the Firecrawl repository into `~/.applyd/firecrawl` and runs it under `docker compose`. That clone is a *separate work* owned by the user; the AGPL copyleft applies to anyone who *modifies and serves* Firecrawl on the network. applyd only makes outbound HTTP calls to a Firecrawl instance the user runs locally — we don't ship a modified Firecrawl, don't expose it as a network service, and don't redistribute its source. The AGPL does not propagate into the MIT-licensed applyd codebase under this usage pattern.

The other integrations are clean MIT / closed-source SaaS:

- **Notion** — closed-source SaaS; we call the public REST API.
- **Bright Data** — closed-source SaaS; we call the public REST API.
- **Greenhouse / Ashby / Lever / Workable** — public job-board JSON endpoints, no auth.

## Reporting a vulnerability

Open a GitHub issue at https://github.com/marz1307/applyd/issues. Mark security-sensitive reports as a **Security advisory** under the repository's Security tab so the report stays private until a fix lands.

## Scan-noise notes

### Poltergeist secret scans pick up `node_modules/`

The Poltergeist secrets scanner does not honour `.gitignore` and has no built-in exclusion flag. When run against this repo locally, it surfaces ~20 candidates from `node_modules/` (`dotenv` README PEM examples, Playwright protocol type identifiers, Babel parser identifiers, OIDC discovery metadata field names). All are documentation strings, identifier names, or vendored library code — not real secrets.

For pristine scans, run Poltergeist against user-authored paths only:

```bash
poltergeist . modes templates config providers batch dashboard .github
# (skipping node_modules/, output/, data/, reports/)
```

The CI does not run Poltergeist; the in-repo `scripts/test-all.mjs` Check 8 covers the same surface using a tighter pattern set that excludes vendored code.

### Go stdlib advisories flagged on the dashboard

The dashboard module ships with a `toolchain go1.24.7` directive so future builds pull a patched Go toolchain that fixes most of the stdlib advisories surfaced in the baseline scan. None of the advisories are reachable from the dashboard's code path (no `net/http`, no `crypto/tls`, no `html/template`, no `archive/tar`, etc.), so this is hygiene only — not a fix for a real exposure.

Dependabot opens a PR every week to bump the Go module dependencies. Merge those promptly to keep the advisory backlog clean.
