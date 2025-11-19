/**
 * Core Interfaces
 *
 * Framework-agnostic interfaces enabling audit logging to work with any ORM.
 *
 * @packageDocumentation
 */

export type {
  CreateArgs,
  DbClient,
  DeleteArgs,
  FindArgs,
  ModelDelegate,
  UpdateArgs,
} from './db-client.js';

export type {
  FieldMetadata,
  RelationField,
  SchemaMetadata,
  UniqueConstraint,
} from './schema-metadata.js';

export type { Transaction } from './transaction.js';
