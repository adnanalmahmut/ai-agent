import { config } from 'dotenv';

config();

//
//
process.env.REDIS_URL ??= 'redis://localhost:6378';
process.env.REDIS_KEY_PREFIX ??= 'test';
process.env.QUEUE_PREFIX ??= 'test-bmq';

process.env.APP_ENCRYPTION_KEY ??=
  'dGVzdC1vbmx5LWZha2UtbWFzdGVyLWtleS0zMmJ5dGU=';
process.env.APP_ENCRYPTION_ACTIVE_KEY_VERSION ??= 'test-v1';
process.env.APP_ENCRYPTION_DECRYPT_KEYS ??= '';

process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.NODE_ENV = 'test';

process.env.MAIL_DRIVER ??= 'log';
process.env.MAIL_FROM_ADDRESS ??= 'no-reply@example.test';
process.env.MAIL_LOG_WRITE_HTML = 'false';

process.env.APP_PLATFORM_URL = 'http://localhost:3001/platform';

process.env.GOOGLE_AUTH_ENABLED ??= 'false';

process.env.OPENAPI_ENABLED ??= 'true';
