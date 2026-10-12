import { setupSQLiteDatabase, teardownSQLiteDatabase } from '../helpers/setup-sqlite.js';
import { describeCrudSmoke } from './crud-smoke-suite.js';

describeCrudSmoke({ name: 'SQLite', setup: setupSQLiteDatabase, teardown: teardownSQLiteDatabase });
