# Local Sleep Parity and Development Banner

## Goal

Make the real-data localhost environment trustworthy for small UI and feature work. A bounded sleep sync must populate the local PostgreSQL database and render the same sleep contract used in production. Localhost must also be visually unmistakable from production.

## Environment model

Production and development run the same application schema against separate PostgreSQL databases. Production history remains in Hetzner's persistent Docker storage. Development data remains in the laptop's `health-hub-postgres-live` Docker volume. No production health rows or database dump will be copied locally.

Both applications currently use the authenticated Hetzner n8n Google Health gateway. This task may inspect that gateway but will not deploy the application, modify production health data, or change the legacy sleep workflow.

## Sleep diagnosis and repair

Select one recent civil date with a stored production sleep session. Trace only that bounded date through:

1. Production sleep row presence and deployed application version.
2. Google Health response metadata returned through the health-hub n8n gateway.
3. The sleep normalizer's accepted and rejected record counts.
4. Local `sleep_sessions` and `sleep_stages` persistence.
5. The authenticated localhost dashboard and sleep APIs.

The first boundary where records disappear determines the fix. The fix will be limited to that boundary and protected by a failing regression test before production code changes.

## Development indicator

Add a thin orange `LOCAL DEVELOPMENT` banner above the application header. It appears only when the browser hostname is `localhost`, `127.0.0.1`, or `::1`. Production markup and layout remain otherwise unchanged, and the banner requires no secret or additional backend configuration.

The banner remains visible while navigating between workspaces and adapts to phone widths. A focused UI contract test will verify the label, local-host detection, and hidden production behavior.

## Verification and alignment

Verification is intentionally bounded:

- Run focused sleep, synchronization, and UI tests.
- Sync only the selected sleep range locally.
- Confirm local database row counts and authenticated UI responses without printing health values.
- Run the complete automated suite once after focused checks pass.
- Compare the local Git commit and runtime configuration shape with the deployed Hetzner application, reporting any remaining code or environment differences before proposing a push.

Success means localhost shows real sleep data for the selected date, the development banner is visible locally and absent on the production hostname, the branch is clean and tested, and no production deployment has occurred.
