// Uso: node --test testes/gate-escopo.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { arquivosAlterados, mensagemEscopo } from '../factory/lib/gate.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('arquivo alterado em commit do construtor conta como alterado', async () => {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-escopo-'));
  git(wt, 'init', '-q');
  git(wt, 'config', 'user.email', 't@t'); git(wt, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(wt, 'a.md'), 'um\n');
  git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'base');
  const base = git(wt, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(wt, 'a.md'), 'um\ndois\n');
  git(wt, 'commit', '-qam', 'construtor');
  assert.equal(git(wt, 'diff', '--name-only'), '', 'git diff sem argumento fica vazio');
  assert.deepEqual(await arquivosAlterados({ worktree: wt, base }), ['a.md']);
  const msg = mensagemEscopo(['- a.md: fora de "Permitido alterar"'], base);
  assert.ok(msg.includes(`git diff ${base}`) && msg.includes('commitado'));
});
