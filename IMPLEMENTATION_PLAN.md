# Cloud Storage & File Sharing System
## Implementation plan for separate chats

The [project plan](PROJECT_PLAN.md) defines the working release, links to the two SRS versions, and identifies the final evidence. Use v0.2 to drive implementation and verification, and consult v0.1 for the corresponding scope and carried-forward requirements.

Work through the checkpoints in dependency order within the overall seven-day window. A checkpoint is complete when its finish line is verified. Each chat should handle one authorized checkpoint or a smaller part of it. In a short session, take the smallest testable part and leave a handoff. Resume the same checkpoint later or authorize the next one when its dependencies are ready.

The [project specification](PROJECT_SPECIFICATION.md) sets the product behavior, acceptance criteria, and chosen stack. The local foundation uses a Next.js web app, a modular NestJS API with Fastify, and PostgreSQL 17 in Docker Compose. Deploy the full system on one Linux VM in Step 2. The [setup guide](README.md) covers the local commands. Record acceptance runs in [requirements coverage](REQUIREMENTS_COVERAGE.md).

## How to work with Codex

1. Authorize the step or subtask in a new chat in this folder. Start with the current handoff, the applicable part of the project plan, and the relevant SRS sections and source files.
2. Inspect the working tree. Pick a testable chunk with one outcome, implement it through the normal user or operator workflow, and run focused checks. Add or update only the tests and evidence needed for the work.
3. Save the handoff after each verified chunk and before ending the chat. Record the exact rerun command or manual check, the result, where evidence lives, and the first unfinished action. If a chat ends unexpectedly, resume from the most recent saved checkpoint.
4. Keep handoffs concise. Link files and summarize test results with the relevant error lines. Reopen only the earlier decision or evidence that the new chat needs. Stop at the authorized scope.
5. In chat, give the local browser test steps and Git commands after each implementation step. The project owner runs the manual checks and commits and pushes the changes.

Start a chat with the following prompt. Replace the last line as needed for a shorter session.

~~~text
Work on Step [number] of IMPLEMENTATION_PLAN.md in this folder.
Read Current handoff, the applicable part of PROJECT_PLAN.md, and the relevant SRS sections.
Continue from the recorded checkpoint. Run the focused checks and update Current handoff.
For this chat, complete the step or this specific subtask: [subtask if useful].
~~~

## Implementation checkpoints

Read v0.2 pp. 6–9 and 12 by requirement ID for the criteria linked below. Use pp. 4–5 for the share and access sequences, p. 10 for the domain model, and p. 11 for non-functional verification.

### Step 1 · Confirm the foundation

Establish version control and the repository foundation when implementation is authorized. Use the SRS to start the requirements coverage record for FR-01 through FR-10 and TC-01 through TC-15. Confirm the framework, VM, identity provider and directory, file persistence, delivery and alert channel, and test approach. Exercise access to the infrastructure and record real dependencies and applicable class constraints. Choose test accounts, an internal group, and sample files to reuse across verification.

**Finish line.** The project starts in a known environment. Dependencies are verified or have a recorded blocker and next action. The SRS coverage record is ready to collect results.

### Step 2 · Deploy a minimal end-to-end flow

Connect the identity provider and implement a minimal authenticated upload and download. Deploy the first working flow with Docker Compose on the VM, and start CI with focused checks. This checkpoint gives later work a functioning deployment and a path for testing normal use. **FR-01–02, TC-01–02.**

**Finish line.** An eligible employee can sign in, upload a sample file, and download the same bytes on the VM. An ineligible identity is denied, the file survives container recreation, and CI reports the first behavioral check.

### Step 3 · Finish identity, storage, and folders

Verify the applicable valid, invalid, inactive, and external identity states. Complete approved types, size and quota enforcement, integrity checks, and authorized folder browsing, creation, rename, move, and retrieval. Use small cases for quick feedback and run the original file-size and quota boundaries for acceptance evidence. **FR-01–03, TC-01–03.**

**Finish line.** The original identity, storage, and folder criteria have results. The system rejects blocked or oversized uploads, unauthorized actions, and cyclic moves. Allowed operations preserve data integrity.

### Step 4 · Implement share creation and access control

Support named internal employees and approved groups for file and folder shares. Enforce the SRS permission levels and link expiry and revocation. Apply the authorization decision within the server workflow and handle rejected shares or access requests clearly. **UC-03/04, FR-04–05, TC-04–05.**

**Finish line.** A valid request creates one revocable share, and the allowed user or group receives only the permitted action. The access matrix exercises allowed and denied cases with identity, link state, and action, and denied requests return no file content.

### Step 5 · Add controlled revisions and audit records

Keep current-version selection and publication consistent. Reject stale updates and record attributable outcomes for the workflows already available. Add audit verification as the remaining workflows land. **FR-07–08, TC-07–08.**

**Finish line.** An authorized editor publishes a revision and the same share returns it. A stale update leaves that revision current. Each exercised event generates one expected logical audit entry.

### Step 6 · Deliver links and security alerts

Connect the selected email or chat integration. Add delivery status, corrective feedback, safe retry, and the copy-link fallback. Configure high-risk event alerts and verify delivery to the security test destination. This can be split into delivery, failure and retry, and alert subtasks. **UC-05/06/08, FR-06/08, TC-06/08.**

**Finish line.** A link reaches its recipient, a controlled failure is visible, a retry uses the original share, and each configured alert reaches its expected destination.

### Step 7 · Implement IT policy administration

Build and verify all five policy settings from FR-09. Apply the selected file-type and quota policy to uploads, expiry to links, access status to identities, and retention to the applicable deletion and recovery behavior. Add tests for authorized and denied admin changes and their audit records. Split the settings into small chats when convenient. **FR-08–09, TC-08–09, NFR-14.1.**

**Finish line.** All five settings change without source edits and have an observable effect. Unauthorized changes are denied. Successful changes and the exercised deletion and retention events have the expected records.

### Step 8 · Prove protected recovery

Keep backups of metadata and file bytes in protected storage, configure the backup process and relevant monitoring, and exercise authorized recovery in a clean test instance. Verify restored state, including live share permissions and file hashes, and record the drill. **FR-08/10, TC-08/10, NFR-13.2.**

**Finish line.** The recovery instructions are repeatable, restored downloads match their expected hashes, and backup timestamps, recovery timing, and audit results are recorded against the original fit criteria.

### Step 9 · Verify product quality and readiness

Run the full acceptance and regression suite in CI and the main workflow on the VM. Verify the remaining quality criteria and record results for TC-11 through TC-15, including UI and locale, usability and accessibility, performance, encryption, and compliance dependencies. Verify policies and recovery in the deployed environment. Ask first-time users to complete the real workflow, fix the issues you observe, and rerun affected checks. Use smaller sessions for accessibility, performance, and operational verification if needed.

**Finish line.** The project can be deployed and operated using its instructions. The coverage record includes observed results, retests, and outstanding requirements or external evidence. Resolve project-controlled release blockers before proceeding to the final review.

### Step 10 · Prepare the class and portfolio release

Rehearse the original SRS workflow with the requirement mapping, Docker/VM deployment, and actual test and restore evidence. Capture the demo, architecture diagram, CI and coverage links, and a concise case-study outline. Use sample files and test accounts in the portfolio evidence.

**Finish line.** The working product and evidence are ready for the three lecturers. The portfolio case study can show the problem, your role, a design decision, and verified outcomes. Select any further improvement in a separate chat and link it to the relevant requirement or observed user need.

## Current handoff

Update this section after each meaningful checkpoint. Keep the last verified result and the smallest next action easy to find.

- **Last verified checkpoint or subtask** — Step 2 local slice passed in Docker Compose on Docker Desktop's Linux environment. Keycloak sign-in, private owner upload/download, and persisted bytes and session state were verified in Chrome.
- **Current step and status** — Step 2 local implementation complete. Class VM deployment and the first hosted CI run are pending.
- **Changed files or revision** — OIDC authentication and file modules, PostgreSQL migrations, the local Compose app and Nginx, the file workspace, browser tests, and the GitHub Actions workflow.
- **Verification and evidence** — `npm run typecheck`, the production Docker build, and `npm run test:e2e -- --workers=1` passed. Three browser checks covered upload and byte-for-byte download, sign-out, and denial of the inactive and external fixture accounts. The owner case also checked anonymous denial, rejection of an unsupported file, and a separate employee's denied download. A 390 px browser viewport fit the workspace. Recreating the API container preserved the session and downloaded bytes. See [TC-01 and TC-02](REQUIREMENTS_COVERAGE.md#srs-v02-tests) for the coverage limits.
- **Open dependencies** — Confirm authorized class VM access, its storage, and its HTTPS origin before deploying. Observe the first GitHub Actions run after the owner pushes. The class OIDC fixture is verified locally. Organization identity integration, the full type allowlist, folder destinations, and original 2 GB per-file and 20 GB quota evidence remain open.
- **Next action** — With authorized VM access, deploy the initial slice and repeat the first-file checks there. Step 3 can extend the verified local slice to the original FR-01–03 criteria once authorized.
