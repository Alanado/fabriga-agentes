// Criação e limpeza dos worktrees: branch, .env do slot, Docker Compose do slot e permissões.
import fs from 'node:fs';
import path from 'node:path';
import {
  git, run, sh, existe, lerTexto, gravarTexto, gravarJSON, mkdirp, lerEnv, preencher, log, falhar, cauda,
} from './util.mjs';
import { lerEstado, gravarEstado, registrar, ocuparSlot, liberarSlot, STATUS } from './state.mjs';

const EXCLUIR = ['.env', '.slot/', '.factory-request.md'];

export const nomeCompose = (ctx, slot) => `fab-${ctx.repo}-s${slot}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
export const dirRun = (ctx, id) => path.join(ctx.dirs.state, 'run', id);

/** Variáveis do slot: portas deslocadas + extras com {worktree}, {slot}, {id}. */
export function envDoSlot(ctx, slot, wt, id) {
  const env = {};
  for (const [k, base] of Object.entries(ctx.profile.env || {})) {
    env[k] = String(Number(base) + ctx.profile.portStep * slot);
  }
  const valores = { worktree: wt, slot, id, repo: ctx.repo };
  for (const [k, v] of Object.entries(ctx.profile.envExtra || {})) env[k] = preencher(v, valores);
  if (ctx.profile.compose?.enabled) env.COMPOSE_PROJECT_NAME = nomeCompose(ctx, slot);
  return env;
}

function escreverDotEnv(ctx, wt, envSlot) {
  const exemplo = path.join(wt, '.env.example');
  if (!existe(exemplo) && Object.keys(envSlot).length === 0) return;
  const usadas = new Set();
  const linhas = existe(exemplo)
    ? lerTexto(exemplo).split('\n').map((linha) => {
        const m = linha.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (m && m[1] in envSlot) {
          usadas.add(m[1]);
          return `${m[1]}=${envSlot[m[1]]}`;
        }
        return linha;
      })
    : [];
  const extras = Object.keys(envSlot).filter((k) => !usadas.has(k));
  if (extras.length) {
    linhas.push('', '# --- gerado pela fábrica (slot) ---');
    for (const k of extras) linhas.push(`${k}=${envSlot[k]}`);
  }
  gravarTexto(path.join(wt, '.env'), linhas.join('\n').trimEnd() + '\n');
}

async function garantirExclusoes(ctx) {
  const comum = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], ctx.raiz);
  const arq = path.join(comum, 'info', 'exclude');
  const atual = existe(arq) ? lerTexto(arq) : '';
  const faltam = EXCLUIR.filter((l) => !atual.split('\n').includes(l));
  if (faltam.length) {
    gravarTexto(arq, atual.trimEnd() + '\n# fábrica de agentes\n' + faltam.join('\n') + '\n');
  }
}

/** Ambiente completo para comandos do worktree (.env + variáveis do slot). */
export function ambienteDoWorktree(ctx, est) {
  return { ...lerEnv(path.join(est.worktree, '.env')), ...envDoSlot(ctx, est.slot, est.worktree, est.id) };
}

export async function compose(ctx, est, acao) {
  const c = ctx.profile.compose;
  if (!c?.enabled) return;
  const arq = path.join(est.worktree, c.file);
  const base = ['compose', '-p', nomeCompose(ctx, est.slot)];
  if (existe(arq)) base.push('-f', arq);
  if (existe(path.join(est.worktree, '.env'))) base.push('--env-file', path.join(est.worktree, '.env'));
  const args = acao === 'down' ? [...base, 'down', '-v', '--remove-orphans'] : [...base, 'up', '-d', '--wait', ...(c.services || [])];
  const r = await run('docker', args, { cwd: est.worktree, env: ambienteDoWorktree(ctx, est) });
  if (r.code !== 0 && acao !== 'down') falhar(`docker compose ${acao} falhou (slot ${est.slot}):\n${cauda(r.stderr || r.stdout, 30)}`);
}

/** Reinicia o banco do slot a partir do seed (down -v + up). */
export async function resetarBanco(ctx, est) {
  if (!ctx.profile.compose?.enabled) return;
  log.info(est.id, `recriando banco do slot ${est.slot}`);
  await compose(ctx, est, 'down');
  await compose(ctx, est, 'up');
}

/** Gera os arquivos de permissão do construtor fora do worktree (não aparecem no diff). */
export function gerarPermissoes(ctx, est, tarefa) {
  const wt = est.worktree;
  const abs = (g) => `//${path.join(wt, g.replace(/^\.?\//, '')).replace(/^\//, '')}`;
  const sempreProibidos = [...ctx.profile.gate.alwaysForbidden, ...tarefa.proibidos];
  const dir = dirRun(ctx, est.id);
  mkdirp(dir);

  // Claude Code (perfil trabalho): modo default + allow; o que não está liberado é negado em -p.
  gravarJSON(path.join(dir, 'claude-settings.json'), {
    permissions: {
      allow: [
        ...tarefa.permitidos.map((g) => `Edit(${abs(g)})`),
        `Edit(${abs('.factory-request.md')})`,
        ...ctx.profile.builder.bashAllow.map((c) => `Bash(${c})`),
      ],
      deny: [
        ...sempreProibidos.map((g) => `Edit(${abs(g)})`),
        ...ctx.profile.builder.readDeny.map((g) => `Read(${abs(g)})`),
        'WebFetch',
        'WebSearch',
        'Bash(git commit *)',
        'Bash(git push *)',
        'Bash(git checkout *)',
        'Bash(git reset *)',
        'Bash(git rebase *)',
        'Bash(rm -rf *)',
        'Bash(curl *)',
        'Bash(wget *)',
      ],
    },
  });

  // OpenCode (perfil pessoal): a última regra que casa vence, então o curinga vem primeiro.
  const edit = { '*': 'deny' };
  for (const g of [...tarefa.permitidos, '.factory-request.md']) {
    edit[g] = 'allow';
    edit[path.join(wt, g)] = 'allow';
  }
  for (const g of sempreProibidos) {
    edit[g] = 'deny';
    edit[path.join(wt, g)] = 'deny';
  }
  const read = { '*': 'allow' };
  for (const g of ctx.profile.builder.readDeny) {
    read[g] = 'deny';
    read[path.join(wt, g)] = 'deny';
  }
  const bash = { '*': 'deny' };
  for (const c of ctx.profile.builder.bashAllow) bash[c] = 'allow';
  for (const c of ['git commit *', 'git push *', 'git checkout *', 'git reset *', 'rm -rf *', 'curl *', 'wget *']) bash[c] = 'deny';
  gravarJSON(path.join(dir, 'opencode.json'), {
    $schema: 'https://opencode.ai/config.json',
    share: 'disabled',
    permission: { edit, read, bash, webfetch: 'deny', websearch: 'deny', external_directory: 'deny', task: 'deny' },
  });
}

/** Pasta, na main, onde o planejador guarda os testes de aceite de uma tarefa (espelhando os caminhos do projeto). */
export const dirAceite = (ctx, id) => path.join(ctx.dirs.fab, 'acceptance', id);

/**
 * Copia os testes de aceite da tarefa para os caminhos finais e commita no branch.
 * Assim eles só entram na main com o merge da feature, e outras tarefas da onda não os veem falhando.
 */
async function commitarAceite(ctx, tarefa, wt) {
  if (tarefa.aceite.length === 0) return;
  for (const f of tarefa.aceite) {
    const origem = path.join(dirAceite(ctx, tarefa.id), f);
    if (!existe(origem)) falhar(`Teste de aceite não encontrado: .factory/acceptance/${tarefa.id}/${f}`);
    mkdirp(path.dirname(path.join(wt, f)));
    fs.copyFileSync(origem, path.join(wt, f));
  }
  await git(['add', '--', ...tarefa.aceite], wt);
  await git(['commit', '--no-verify', '-m', `test(${tarefa.id}): testes de aceite`], wt);
}

/** Base do diff: o commit dos testes de aceite (primeiro commit do branch) ou a main. */
export async function calcularBase(ctx, tarefa, wt) {
  const main = ctx.profile.mainBranch;
  if (tarefa.aceite.length === 0) return git(['rev-parse', main], wt);
  const commits = (await git(['rev-list', '--reverse', `${main}..HEAD`], wt)).split('\n').filter(Boolean);
  return commits[0] || git(['rev-parse', main], wt);
}

export async function criarWorktree(ctx, tarefa) {
  const est = lerEstado(ctx, tarefa.id);
  if (est.worktree && existe(est.worktree)) return est;

  const slot = ocuparSlot(ctx, tarefa.id, tarefa.slot);
  const wt = path.join(ctx.dirs.worktrees, tarefa.id);
  const branch = `feat/${tarefa.id}`;
  try {
    mkdirp(ctx.dirs.worktrees);
    await garantirExclusoes(ctx);
    const main = ctx.profile.mainBranch;
    const existeBranch = (await git(['rev-parse', '--verify', '--quiet', branch], ctx.raiz, { permitirFalha: true })).code === 0;
    if (existeBranch) await git(['worktree', 'add', wt, branch], ctx.raiz);
    else await git(['worktree', 'add', '-b', branch, wt, main], ctx.raiz);
    if (!existeBranch) await commitarAceite(ctx, tarefa, wt);
    const base = await calcularBase(ctx, tarefa, wt);

    Object.assign(est, { status: STATUS.EM_ANDAMENTO, slot, worktree: wt, branch, base });
    mkdirp(path.join(wt, '.slot'));
    escreverDotEnv(ctx, wt, envDoSlot(ctx, slot, wt, tarefa.id));
    gerarPermissoes(ctx, est, tarefa);
    registrar(est, 'worktree-criado', { slot, wt });
    gravarEstado(ctx, est);
    log.ok(tarefa.id, `worktree em ${wt} (slot ${slot}, branch ${branch})`);

    await compose(ctx, est, 'up');
    for (const cmd of ctx.profile.setup || []) {
      log.info(tarefa.id, `setup: ${cmd}`);
      const r = await sh(cmd, { cwd: wt, env: ambienteDoWorktree(ctx, est) });
      if (r.code !== 0) falhar(`setup "${cmd}" falhou:\n${cauda(r.stderr || r.stdout, 30)}`);
    }
    return est;
  } catch (e) {
    registrar(est, 'erro-ao-criar-worktree', { erro: String(e.message).slice(0, 500) });
    est.status = STATUS.BLOQUEADA;
    gravarEstado(ctx, est);
    throw e;
  }
}

export async function removerWorktree(ctx, id, { descartar = false } = {}) {
  const est = lerEstado(ctx, id);
  if (est.worktree) {
    await compose(ctx, est, 'down').catch(() => {});
    if (existe(est.worktree)) await git(['worktree', 'remove', '--force', est.worktree], ctx.raiz, { permitirFalha: true });
    await git(['worktree', 'prune'], ctx.raiz, { permitirFalha: true });
  }
  if (est.branch) {
    await git(['branch', descartar ? '-D' : '-d', est.branch], ctx.raiz, { permitirFalha: true });
  }
  liberarSlot(ctx, est.slot, id);
  fs.rmSync(dirRun(ctx, id), { recursive: true, force: true });
  est.status = descartar ? STATUS.DESCARTADA : STATUS.MERGEADA;
  registrar(est, descartar ? 'descartada' : 'limpa');
  est.worktree = null;
  gravarEstado(ctx, est);
}
