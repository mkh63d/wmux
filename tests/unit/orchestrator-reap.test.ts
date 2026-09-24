import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashExists, forBash, hasBash } from '../helpers/bash-path';
import { createWmuxStub, removeWmuxStub, type WmuxStub } from '../helpers/wmux-stub';

const SCRIPTS = path.resolve(__dirname, '../../resources/wmux-orchestrator/scripts');
const REAP = path.join(SCRIPTS, 'reap-wave.sh');
const JSON_TOOL = path.join(SCRIPTS, 'json-tool.js');

const reapPath = forBash(REAP);
const canRun = hasBash() && bashExists(reapPath);

let tmp: string;
let orchDir: string;
let stub: WmuxStub;

interface AgentFixture {
  id: string;
  status?: string;
  wmuxAgentId?: string;
  surfaceId?: string;
  paneId?: string;
  reapedAt?: string;
}

function writeState(waves: AgentFixture[][], extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(orchDir, 'state.json'),
    JSON.stringify({
      id: 'test',
      task: 't',
      status: 'running',
      coordinatorPaneId: 'pane-coord',
      waves: waves.map((agents) => ({ status: 'complete', agents: agents.map((a) => ({ status: 'exited', ...a })) })),
      ...extra,
    }),
  );
}

const readState = () => JSON.parse(fs.readFileSync(path.join(orchDir, 'state.json'), 'utf8'));
const agentOf = (wave: number, i = 0) => readState().waves[wave].agents[i];

function reap(sel: string, env: Record<string, string> = {}) {
  return stub.bash(`bash "${reapPath}" "${forBash(orchDir)}" ${sel}`, env);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-reap-'));
  orchDir = path.join(tmp, 'wmux-orch-test');
  fs.mkdirSync(orchDir);
  stub = createWmuxStub();
});

afterEach(() => {
  removeWmuxStub(stub);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Each script run spawns several node processes under Git Bash, ~2-3 s on Windows.
const SLOW = 30_000;

describe.skipIf(!canRun)('reap-wave.sh', { timeout: SLOW }, () => {
  it('kills the agent, then closes its surface, then stamps reapedAt', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'agent-1', surfaceId: 'surf-1', paneId: 'pane-1' }]]);
    stub.assertReachable();

    const r = reap('0');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill agent-1', 'close-surface surf-1']);
    expect(agentOf(0).reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('reaps only the named wave', () => {
    writeState([
      [{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }],
      [{ id: 'b1', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' }],
    ]);
    stub.assertReachable();

    reap('1');

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2']);
    expect(agentOf(0).reapedAt).toBeUndefined();
    expect(agentOf(1).reapedAt).toBeDefined();
  });

  it('reaps every wave and stamps the run when given "all"', () => {
    writeState([
      [{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }],
      [{ id: 'b1', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' }],
    ]);
    stub.assertReachable();

    reap('all');

    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1', 'agent kill g2', 'close-surface s2']);
    const state = readState();
    expect(state.reapedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(state.waves[0].agents[0].reapedAt).toBeDefined();
    expect(state.waves[1].agents[0].reapedAt).toBeDefined();
  });

  it('does not stamp the run for a single wave', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    reap('0');

    expect(readState().reapedAt).toBeUndefined();
  });

  it('reaps whatever the agent status, a failed one included', () => {
    writeState([[{ id: 'a1', status: 'failed', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    reap('0');

    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
  });

  it('a second run calls nothing beyond ping', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();
    reap('all');
    expect(stub.calls().length).toBeGreaterThan(1);
    stub.clearCalls();

    const r = reap('all');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping']);
  });

  it('closes the surface even when the agent id is unknown', () => {
    writeState([[{ id: 'a1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    reap('0');

    expect(stub.calls()).toEqual(['ping', 'close-surface s1']);
    expect(agentOf(0).reapedAt).toBeDefined();
  });

  it('ignores failing kill and close, and still sets reapedAt', () => {
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.reply('agent kill', { exit: 1, stderr: 'Agent not found' });
    stub.reply('close-surface', { exit: 1 });
    stub.assertReachable();

    const r = reap('0');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping', 'agent kill g1', 'close-surface s1']);
    expect(agentOf(0).reapedAt).toBeDefined();
  });

  it('skips agents with no surface (never spawned)', () => {
    writeState([[{ id: 'a1', status: 'pending' }]]);
    stub.assertReachable();

    reap('all');

    expect(stub.calls()).toEqual(['ping']);
    expect(agentOf(0).reapedAt).toBeUndefined();
  });

  it('never closes an agent that sits in the coordinator pane', () => {
    writeState([
      [
        { id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'pane-coord' },
        { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
      ],
    ]);
    stub.assertReachable();

    const r = reap('0');

    expect(stub.calls()).toEqual(['ping', 'agent kill g2', 'close-surface s2']);
    expect(r.stderr).toContain('coordinator');
    expect(agentOf(0, 0).reapedAt).toBeUndefined();
  });

  it('touches nothing when wmux does not answer ping', () => {
    removeWmuxStub(stub);
    stub = createWmuxStub({ pingFails: true });
    writeState([[{ id: 'a1', wmuxAgentId: 'g1', surfaceId: 's1', paneId: 'p1' }]]);
    stub.assertReachable();

    const r = reap('all');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual(['ping']);
    const state = readState();
    expect(state.waves[0].agents[0].reapedAt).toBeUndefined();
    expect(state.reapedAt).toBeUndefined();
  });

  it("kills the caller's own surface last, so it cannot cut the loop short (A14)", () => {
    writeState([
      [
        { id: 'a1', wmuxAgentId: 'g1', surfaceId: 'own', paneId: 'p1' },
        { id: 'a2', wmuxAgentId: 'g2', surfaceId: 's2', paneId: 'p2' },
        { id: 'a3', wmuxAgentId: 'g3', surfaceId: 's3', paneId: 'p3' },
      ],
    ]);
    stub.assertReachable();

    reap('0', { WMUX_SURFACE_ID: 'own' });

    expect(stub.calls()).toEqual([
      'ping',
      'agent kill g2',
      'close-surface s2',
      'agent kill g3',
      'close-surface s3',
      'agent kill g1',
      'close-surface own',
    ]);
  });

  it('exits 0 with no wmux call when state.json is missing', () => {
    fs.rmSync(path.join(orchDir, 'state.json'), { force: true });
    stub.assertReachable();

    const r = reap('all');

    expect(r.status).toBe(0);
    expect(stub.calls()).toEqual([]);
  });

  it('rejects a bad wave selector with exit 1', () => {
    writeState([[]]);
    expect(reap('nope').status).toBe(1);
  });
});

describe.skipIf(!hasBash())('json-tool reaping queries', { timeout: SLOW }, () => {
  const tool = (...args: string[]) => execFileSync('node', [JSON_TOOL, ...args], { encoding: 'utf8' });

  it('find-unreaped-finished lists only finished, coordinator-bearing, unreaped runs', () => {
    const mk = (name: string, state: Record<string, unknown> | null) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d);
      if (state) fs.writeFileSync(path.join(d, 'state.json'), JSON.stringify(state));
    };
    mk('wmux-orch-complete', { status: 'complete', coordinatorPaneId: 'p' });
    mk('wmux-orch-aborted', { status: 'aborted', coordinatorPaneId: 'p' });
    mk('wmux-orch-failed', { status: 'failed', coordinatorPaneId: 'p' });
    mk('wmux-orch-running', { status: 'running', coordinatorPaneId: 'p' });
    mk('wmux-orch-nocoord', { status: 'complete' });
    mk('wmux-orch-reaped', { status: 'complete', coordinatorPaneId: 'p', reapedAt: '2026-01-01T00:00:00Z' });
    mk('wmux-orch-nostate', null);
    mk('wmux-orch-garbage', null);
    fs.writeFileSync(path.join(tmp, 'wmux-orch-garbage', 'state.json'), '{not json');
    mk('unrelated', { status: 'complete', coordinatorPaneId: 'p' });

    const names = tool('find-unreaped-finished', tmp)
      .split('\n')
      .filter(Boolean)
      .map((p) => p.split('/').pop());

    expect(names).toEqual(['wmux-orch-aborted', 'wmux-orch-complete', 'wmux-orch-failed']);
  });

  it('find-unreaped-finished prints nothing for a missing base dir', () => {
    expect(tool('find-unreaped-finished', path.join(tmp, 'nope'))).toBe('');
  });

  it('reap-candidates skips reaped and surface-less agents and puts the caller last', () => {
    writeState([
      [
        { id: 'a1', wmuxAgentId: 'g1', surfaceId: 'own', paneId: 'p1' },
        { id: 'a2', surfaceId: 's2' },
        { id: 'a3', surfaceId: 's3', paneId: 'p3', reapedAt: 'x' },
        { id: 'a4', status: 'pending' },
      ],
    ]);

    const out = tool('query', path.join(orchDir, 'state.json'), 'reap-candidates', 'all', 'own');

    expect(out.split('\n').filter(Boolean)).toEqual(['a2\t-\ts2\t-', 'a1\tg1\town\tp1']);
  });
});
