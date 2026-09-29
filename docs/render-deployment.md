# Deploying SMIS to Render

`render.yaml` defines the paid web service and managed PostgreSQL database.
The app and database are in the same Render region; the database's public IP
allowlist is empty, the web service uses the internal database URL, and Render
generates the session secret. The web service remains HTTPS-only at its public
URL. The configured Render plans incur charges; review Render's current
pricing in the Blueprint creation flow before confirming.

## Provision the Blueprint

1. Push the project, including `render.yaml`, to a GitHub or GitLab repository.
   This workspace is not currently connected to a Git repository.
2. Sign in to Render, create a Blueprint from the repository, review the
   resources and prices, and approve creation.
3. Wait for the first deploy. The paid web service runs `npm run migrate`
   before startup. This migration takes a PostgreSQL transaction lock and
   creates the SMIS tables and indexes. Render checks `/api/health`; the
   response is successful only when PostgreSQL is reachable.
4. In the Render service Shell, create the initial admin account:

   ```sh
   npm run create-admin -- admin@example.org "School Administrator"
   ```

   Enter the password at the hidden interactive prompt. The CLI refuses to
   create a second admin. Use `npm run create-user` to provision the
   `registrar`, `inventory`, or `viewer` roles. Do not create the account
   before the first migration has completed.
5. Open the HTTPS service URL, sign in, and run the verification checklist.

The application is same-origin; do not set `CORS_ORIGIN`. Render supplies the
public `PORT`. `HOST=0.0.0.0` lets the service accept Render's health probes.
`DATABASE_SSL=false` applies only to the private connection within Render's
service region. Do not replace `DATABASE_URL` with the externally accessible
database URL.

## Verification checklist

- Render reports the PostgreSQL database and web service as available.
- `https://<your-service>.onrender.com/api/health` returns
  `{"status":"ok","database":"connected"}`.
- The public page opens over HTTPS and staff pages require sign-in.
- The admin account can sign in, add and edit a student, create an item, and
  issue/return that item; inventory quantities update correctly.
- Sign out, sign back in, and verify records persist.
- Confirm a viewer cannot read student records, and an anonymous browser
  cannot access `/api/students`.

## Operations

- Configure and test database backups and restores before entering school
  records. Render's backup/recovery options and retention depend on the
  selected database plan; confirm them in the Render dashboard.
- Limit Render workspace and Shell access to trusted operators. Keep the
  generated session secret and database credentials in Render's protected
  environment configuration; never copy them into Git or logs.
- The schema migration creates missing objects but is not a migration
  framework for changing existing columns or constraints. For future schema
  changes, create and test explicit forward migrations before deploying them.
- Account passwords can currently be reset by an authorized operator by
  provisioning a replacement user, or by a controlled database password-hash
  update workflow. Keep account recovery out of public routes.
- Before importing real records, confirm the full school requirements,
  currency, applicable privacy/data-retention obligations, and the school's
  backup and incident-response process.
