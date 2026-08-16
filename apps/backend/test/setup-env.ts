import { config } from 'dotenv';

// The e2e suites boot the real `AppModule`, whose configuration is validated
// at module init — so the same environment the application needs at runtime
// has to be present here. Loading `.env` keeps that in one place instead of
// duplicating a connection string into the test setup.
config();

process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.NODE_ENV = 'test';

// Mail defaults for tests. The transport is overridden per-suite, so these
// only have to satisfy configuration validation; `log` guarantees that a
// missing override can never send anything real.
process.env.MAIL_DRIVER ??= 'log';
process.env.MAIL_FROM_ADDRESS ??= 'no-reply@example.test';
process.env.MAIL_LOG_WRITE_HTML = 'false';

// Invitation links are built from this; a suite asserting the accept URL needs
// a stable origin rather than whatever a developer's `.env` happens to hold.
process.env.APP_PLATFORM_URL = 'http://localhost:3001/platform';

// Google is off unless a suite turns it on for itself, so the default e2e run
// never depends on credentials that do not exist.
process.env.GOOGLE_AUTH_ENABLED ??= 'false';

// Documentation on by default under test: the OpenAPI suite asserts both
// schemas, and the disabled case is exercised by booting a second app with the
// variable flipped.
process.env.OPENAPI_ENABLED ??= 'true';
