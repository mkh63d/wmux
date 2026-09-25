import { describe, it, expect } from 'vitest';
import { groupWaveAgents } from '../../src/renderer/components/Sidebar/orchestration-groups';
import type { OrchestrationAgent } from '../../src/shared/types';

const agent = (id: string, group?: unknown, status: OrchestrationAgent['status'] = 'running') =>
  ({ id, label: id, status, ...(group === undefined ? {} : { group }) }) as OrchestrationAgent;

const ids = (agents: OrchestrationAgent[]) => agents.map((a) => a.id);

describe('groupWaveAgents', () => {
  it('returns plain agent items when nothing is grouped', () => {
    const items = groupWaveAgents([agent('a'), agent('b')]);
    expect(items.map((i) => i.kind)).toEqual(['agent', 'agent']);
  });

  it('returns nothing for an empty wave', () => {
    expect(groupWaveAgents([])).toEqual([]);
  });

  it('collects members of one group, keeping agents[] order', () => {
    const items = groupWaveAgents([agent('a', 'x'), agent('b'), agent('c', 'x'), agent('d', 'x')]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'group', name: 'x', total: 3 });
    expect(items[0].kind === 'group' && ids(items[0].agents)).toEqual(['a', 'c', 'd']);
    expect(items[1]).toMatchObject({ kind: 'agent', agent: { id: 'b' } });
  });

  it('orders items by first appearance with interleaved groups', () => {
    const items = groupWaveAgents([
      agent('a', 'x'),
      agent('b', 'y'),
      agent('c', 'x'),
      agent('d', 'y'),
      agent('e'),
    ]);
    expect(items.map((i) => (i.kind === 'group' ? i.name : i.agent.id))).toEqual(['x', 'y', 'e']);
  });

  it('returns a one-member group as a plain agent', () => {
    const items = groupWaveAgents([agent('a', 'solo'), agent('b')]);
    expect(items.map((i) => i.kind)).toEqual(['agent', 'agent']);
  });

  it('counts done as exited or failed', () => {
    const [group] = groupWaveAgents([
      agent('a', 'x', 'exited'),
      agent('b', 'x', 'failed'),
      agent('c', 'x', 'running'),
      agent('d', 'x', 'pending'),
    ]);
    expect(group).toMatchObject({ kind: 'group', done: 2, total: 4 });
  });

  it('trims group names and merges padded spellings into one group', () => {
    const items = groupWaveAgents([agent('a', ' x '), agent('b', 'x'), agent('c', '\tx\n')]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'group', name: 'x', total: 3 });
  });

  it('compares group names case-sensitively', () => {
    const items = groupWaveAgents([agent('a', 'X'), agent('b', 'x'), agent('c', 'X'), agent('d', 'x')]);
    expect(items.map((i) => (i.kind === 'group' ? i.name : '?'))).toEqual(['X', 'x']);
  });

  it.each([
    ['number', 5],
    ['object', { name: 'x' }],
    ['array', ['x']],
    ['null', null],
    ['empty string', ''],
    ['blank string', '   '],
    ['boolean', true],
  ])('treats a %s group as ungrouped without throwing', (_label, value) => {
    const items = groupWaveAgents([agent('a', value), agent('b', value)]);
    expect(items.map((i) => i.kind)).toEqual(['agent', 'agent']);
  });

  it('keeps malformed-group agents apart from a real group', () => {
    const items = groupWaveAgents([agent('a', 'x'), agent('b', 5), agent('c', 'x')]);
    expect(items.map((i) => i.kind)).toEqual(['group', 'agent']);
  });

  it('does not throw on non-object entries in agents[]', () => {
    const junk = [null, undefined, 'a'] as unknown as OrchestrationAgent[];
    expect(() => groupWaveAgents(junk)).not.toThrow();
  });
});
