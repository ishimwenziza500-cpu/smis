# First administrator provisioning

SMIS does not provide public registration or default credentials. Create the
first administrator out of band with the `create-admin` CLI after applying
`db/schema.sql` and configuring `DATABASE_URL` and `SESSION_SECRET`.

1. Generate a unique `SESSION_SECRET` with at least 32 random bytes and store
   it in a deployment secret manager or a private `.env` file.
2. Run `npm run create-admin -- <email> "<full name>"` from a trusted
   environment with database access. Enter a unique password (12–256
   characters) at the hidden prompt; it is never passed as a command-line
   argument.
3. Sign in and verify the account has the `admin` role. Retain access to the
   deployment CLI for account recovery.
4. Provision additional named staff accounts out of band with
   `npm run create-user -- <email> "<full name>" <registrar|inventory|viewer>`.

The administrator CLI refuses to create a second administrator; additional
staff-account creation requires an active administrator to exist. Passwords
are stored as Node scrypt hashes. Sessions are stored as hashed tokens in
PostgreSQL and expire after 12 hours. There is intentionally no public signup,
default password, or HTTP bootstrap endpoint.
