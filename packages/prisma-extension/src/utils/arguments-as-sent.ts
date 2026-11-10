/**
 * The arguments of an operation as Prisma sends them
 *
 * Prisma hands every query callback a copy of the arguments in which every object that is not one
 * of its own values (`Date`, `Decimal`, `Buffer` and other typed arrays, `Prisma.DbNull` and the
 * other null values, field references) is a plain object. Its serializer then replaces an object
 * holding a `toJSON` function with what that function returns, so a plain object holding one
 * sends something other than what it holds: a nested write behind a `toJSON` is sent, and is not
 * in the object a reader of the arguments sees. Arguments read as sent have every such object
 * replaced up front, and are what is handed on, so the reader and the database see the same.
 *
 * @module utils/arguments-as-sent
 */

import { isPlainObject } from './is-record.js';

/**
 * `args` with every plain object holding a `toJSON` function replaced with what it returns, read
 * as sent in turn, and every other plain object and list copied, so a later change to `args` does
 * not reach them. Other values, a class instance holding `toJSON` included, are kept as they are.
 */
export const argumentsAsSent = (args: unknown): unknown => {
  if (Array.isArray(args)) {
    return args.map(argumentsAsSent);
  }
  if (!isPlainObject(args)) {
    return args;
  }
  const { toJSON } = args;
  const sent: unknown = typeof toJSON === 'function' ? Reflect.apply(toJSON, args, []) : args;
  // A `toJSON` that returns its own object sends the object's own fields
  return sent === args
    ? Object.fromEntries(Object.entries(args).map(([key, value]) => [key, argumentsAsSent(value)]))
    : argumentsAsSent(sent);
};
