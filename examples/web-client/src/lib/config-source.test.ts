import configSource from '@api/audit.config.ts?raw';
import { describe, expect, it } from 'vitest';
import { configSections } from './config-source';

const lines = configSource.split('\n');
const sections = configSections(configSource);
const section = (id: string) => {
  const found = sections.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No section ${id}`);
  return found;
};
const text = (id: string) => lines.slice(section(id).start, section(id).end + 1).join('\n');

describe('configSections over the demo audit config', () => {
  it('finds every model of the aggregate mapping, in file order', () => {
    expect(sections.filter((candidate) => candidate.kind === 'model').map((candidate) => candidate.id)).toEqual([
      'User',
      'Profile',
      'Post',
      'Comment',
      'Tag',
      'PostTag',
      'PostLike',
    ]);
  });

  it("spans a model's whole defineEntity block and points at each aggregate it maps to", () => {
    expect(text('Comment')).toMatch(/^ {2}Comment: defineEntity/);
    expect(text('Comment')).toMatch(/ {2}\}\),$/);
    expect(section('Comment').aggregates.map((declaration) => declaration.aggregate)).toEqual(['Post', 'User']);
    for (const declaration of section('Comment').aggregates) {
      expect(lines[declaration.line]).toContain(`to('${declaration.aggregate}'`);
    }
  });

  it('tells whether a model is recorded under itself', () => {
    expect(section('Comment').selfAggregate).toBe(true);
    expect(section('PostTag').selfAggregate).toBe(false);
    expect(section('PostLike').selfAggregate).toBe(false);
  });

  it('keeps the comment written above a model with that model', () => {
    expect(lines[section('PostTag').start]).toMatch(/^ {2}\/\/ Join tables/);
    expect(section('PostTag').aggregates.map((declaration) => declaration.aggregate)).toEqual(['Post', 'Tag']);
  });

  it('finds the client-wide settings of defineConfig, one-line and block alike', () => {
    expect(sections.filter((candidate) => candidate.kind === 'setting').map((candidate) => candidate.id)).toEqual([
      'contextProvider',
      'schema',
      'diffExcludeFields',
      'write',
      'actorContext',
    ]);
    expect(text('diffExcludeFields')).toBe("  diffExcludeFields: ['updatedAt', 'createdAt'],");
    expect(text('write')).toContain('awaited: true');
    expect(text('actorContext')).toMatch(/fallback: null,\n {2}\},$/);
  });
});
