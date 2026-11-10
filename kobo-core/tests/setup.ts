process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5433/kobo_test';
process.env.LOG_LEVEL = 'silent';
