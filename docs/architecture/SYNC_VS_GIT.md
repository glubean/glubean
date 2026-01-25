# Comparison: GitHub Integration vs CLI Sync

Glubean offers two primary ways to deploy test code. Understanding the differences helps users choose the right workflow.

| Feature | CLI Sync (`glubean sync`) | GitHub Integration (Git Connect) |
| :--- | :--- | :--- |
| **Primary Use Case** | Local Development, Custom CI/CD | Team Automation, PR Workflows |
| **Setup** | Install CLI, Login | Install GitHub App, Click Connect |
| **Trigger** | Manual command | `git push` |
| **Speed** | Instant (Direct upload) | Slower (Webhook -> Clone -> Build) |
| **Context** | Uses local file state | Uses specific Git commit state |
| **Preview Envs** | No (overwrites or creates new version) | Yes (Automatic for PRs) |
| **Feedback** | Terminal output | GitHub PR Comment / Checks API |
| **Secrets** | Can use local `.env` for dry-run | Must use Platform Secrets |
| **Best For** | **Individual Developer** iterating fast | **Teams** enforcing review process |

## Workflow Recommendation

### 1. The "Inner Loop" (CLI)
Developers use the CLI while writing tests.
*   Write code.
*   `glubean run` (Local execution).
*   `glubean sync --dry-run` (Verify metadata).

### 2. The "Outer Loop" (GitHub)
Teams use GitHub Integration for the source of truth.
*   Developer commits code.
*   GitHub triggers Glubean.
*   Glubean runs tests against Staging.
*   Glubean reports status to PR.
*   Merge to `main` -> Deploys to Production Suite.

**Conclusion:**
They are complementary.
*   **CLI** is for *Creation*.
*   **GitHub** is for *Automation*.
