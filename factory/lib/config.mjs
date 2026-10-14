// Localiza o repositório, carrega profile.json e models.json com valores padrão.
import path from 'node:path';
import { run, lerJSON, existe, falhar } from './util.mjs';

const PADRAO = {
  perfil: 'trabalho',
  slots: 2,
  mainBranch: 'main',
  worktreesDir: '../{repo}-worktrees',
  portStep: 100,
  env: {},
  envExtra: {},
  compose: { enabled: false, file: 'docker-compose.yml', services: [], resetEachTask: true },
  setup: ['npm ci'],
  gate: {
    install: 'npm ci',
    verify: 'npm run verify',
    acceptance: null,
    lintAcceptance: null,
    screenshotsDir: 'test-results',
    forbiddenPatterns: ['\\.only\\(', '\\.skip\\(', '@ts-ignore', '@ts-nocheck', 'eslint-disable'],
    alwaysForbidden: ['tests/acceptance/**', '.factory/**', '.claude/**', 'CLAUDE.md'],
    logTailLines: 80,
    timeoutMin: 20,
  },
  limits: {
    gateRetries: 4,
    reviewRetries: 2,
    modelSwitches: 1,
    transientRetries: 2,
    maxTurns: 60,
    agentTimeoutMin: 45,
  },
  builder: {
    bashAllow: [
      'npm run *', 'npm test', 'npm test *', 'npx vitest *', 'npx playwright *', 'npx tsc *',
      'npx eslint *', 'npx prettier *', 'git status', 'git status *', 'git diff', 'git diff *',
      'git log *', 'ls *', 'cat *', 'grep *', 'find *',
    ],
    // Negações explícitas: um '.env.*' genérico também bloquearia o .env.example, que é versionado e sem segredos.
    readDeny: [
      '.env', '**/.env', '.env.local', '**/.env.local', '.env.development', '**/.env.development',
      '.env.production', '**/.env.production', '.env.test', '**/.env.test', '.env.*.local', '**/.env.*.local',
      '.confidencial.local',
    ],
  },
  review: { model: 'opus', effort: 'high', maxTurns: 20, maxDiffKb: 400 },
};

// `null` no profile desliga a opção; só `undefined` (ausente) herda o padrão.
function mesclar(base, extra) {
  if (extra === undefined) return base;
  if (extra === null || Array.isArray(base) || Array.isArray(extra)) return extra;
  if (typeof base !== 'object' || base === null || typeof extra !== 'object') return extra;
  const out = { ...base };
  for (const k of Object.keys(extra || {})) out[k] = mesclar(base[k], extra[k]);
  return out;
}

/** Raiz do repositório principal (não a de um worktree). */
export async function acharRaiz(cwd = process.cwd()) {
  const r = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (r.code !== 0) falhar('Rode a fábrica dentro de um repositório git.');
  const comum = r.stdout.trim();
  return path.basename(comum) === '.git' ? path.dirname(comum) : comum;
}

export async function carregarContexto(cwd) {
  const raiz = await acharRaiz(cwd);
  const fab = path.join(raiz, '.factory');
  if (!existe(fab)) falhar(`Não achei ${fab}. Rode o install.sh da fábrica neste projeto.`);
  const profile = mesclar(PADRAO, lerJSON(path.join(fab, 'profile.json')));
  if (!['trabalho', 'pessoal'].includes(profile.perfil)) falhar('profile.json: "perfil" deve ser "trabalho" ou "pessoal".');
  const models = lerJSON(path.join(fab, 'models.json'));
  const repo = path.basename(raiz);
  const dirs = {
    raiz,
    fab,
    tasks: path.join(fab, 'tasks'),
    state: path.join(fab, 'state'),
    evidence: path.join(fab, 'evidence'),
    logs: path.join(fab, 'logs'),
    reviews: path.join(fab, 'reviews'),
    requests: path.join(fab, 'requests'),
    templates: path.join(fab, 'templates'),
    worktrees: path.resolve(raiz, profile.worktreesDir.replace('{repo}', repo)),
  };
  return { raiz, repo, profile, models, dirs };
}
