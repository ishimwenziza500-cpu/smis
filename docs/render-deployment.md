# Deploying SMIS to Render

`render.yaml` defines a Render Free web service. PostgreSQL is hosted
separately on Neon Free: Render prompts for its `DATABASE_URL`, uses TLS, and
generates the session secret. The migration runs at application startup, and
the public web service uses HTTPS.

This setup is for a $0 demo, not production. Render Free web services sleep
after 15 minutes without traffic and may take about a minute to wake. Neon
Free currently provides 0.5 GB of storage and suspends compute after five
minutes of inactivity. Neither provider's free tier is an availability or
backup guarantee. Avoid entering real student or staff records; confirm
current provider quotas and terms before proceeding.

## Provision the Blueprint

1. Create a Neon Free project and database, then copy its PostgreSQL
   connection string. Treat it as a password; do not commit it.
2. Sign in to Render and create a Blueprint from the GitHub repository.
   Provide the Neon connection string for the `DATABASE_URL` environment
   variable. The Blueprint creates only a Render Free web service; it does
   not create a Render Postgres database.
3. Wait for the first deploy. The start command runs `npm run migrate` before
   starting the application. This migration takes a PostgreSQL transaction
   lock and creates the SMIS tables and indexes. Render checks `/api/health`;
   the response is successful only when PostgreSQL is reachable.
4. After the first successful deploy (so the startup migration has completed),
   create the initial admin from a trusted Windows PowerShell terminal in the
   project folder. The following prompts for the Neon URL without echoing it,
   creates a temporary CLI-only session secret, and prompts for the admin
   password without echoing it:

   ```powershell
   $secureUrl = Read-Host "Neon PostgreSQL connection string" -AsSecureString
   $urlPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
   try {
     $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($urlPointer)
   } finally {
     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($urlPointer)
   }
   $env:DATABASE_SSL = "true"
   $secretBytes = New-Object byte[] 48
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
   $env:SESSION_SECRET = [Convert]::ToBase64String($secretBytes)
   npm run create-admin -- admin@example.org "School Administrator"
   ```

   The CLI refuses to create a second admin. While the environment variables
   remain set in this terminal, use `npm run create-user` to provision the
   `registrar`, `inventory`, or `viewer` roles if needed. When finished,
   remove the connection string and temporary secret from the terminal:

   ```powershell
   Remove-Item Env:DATABASE_URL, Env:DATABASE_SSL, Env:SESSION_SECRET
   ```

   Do not paste the connection string or passwords into chat, source control,
   or command arguments.
5. Open the HTTPS service URL, sign in, and run the verification checklist.

The application is same-origin; do not set `CORS_ORIGIN`. Render supplies the
public `PORT`. `HOST=0.0.0.0` lets the service accept Render's health probes.
`DATABASE_SSL=true` verifies TLS for the external Neon database connection.
Keep `DATABASE_URL` and the generated session secret private.

## Verification checklist

- Render reports the web service as available and Neon reports the database
  as active when in use.
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
  records. Neon Free does not provide the production backup/recovery
  guarantees needed for real school records.
- Limit Render workspace and Neon access to trusted operators. Keep the
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
