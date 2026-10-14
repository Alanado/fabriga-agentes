#!/usr/bin/env node
// Fábrica de agentes: orquestrador determinístico. O Claude chama estes comandos; eles não gastam tokens.
import path from 'node:path';
import { carregarContexto } from './lib/config.mjs';
import { lerTarefa, listarTarefas } from './lib/task.mjs';
import { lerEstado, listarEstados, gravarEstado, registrar, STATUS } from './lib/state.mjs';
import { criarWorktree } from './lib/worktree.mjs';
import { rodarPortao } from './lib/gate.mjs';
import { rodarRevisao } from './lib/review.mjs';
import {
  executarTarefa, executarOnda, aprovar, reprovar, liberarParaNovaTentativa, descartar, rebaseAbertos, Pausa,
} from './lib/orchestrate.mjs';
import { doctor, verificarPlano } from './lib/checks.mjs';
import { FabError, log } from './lib/util.mjs';

const AJUDA = `fab: fábrica de agentes

Uso: node .factory/fab.mjs <comando> [args]

Planejamento
  plan-check              confere os pacotes: campos, critérios, testes de aceite, sobreposição por onda
  doctor                  confere ferramentas, profile e projeto

Execução
  wave <n>                roda todas as tarefas da onda n, até "slots" em paralelo
  task <id>               roda uma tarefa: construtor → portão → validador
  retry <id> [--reset-model]  libera tarefa bloqueada/em conflito/reprovada e roda de novo
  new <id>                só cria o worktree do slot (sem rodar agente)
  gate <id>               só roda o portão automático
  review <id>             só roda o validador

Decisão (você)
  approve <id>            commit, merge --no-ff na main, limpa o slot e atualiza os outros worktrees
  reject <id> "motivo"    devolve ao agente com o seu motivo
  discard <id>            apaga worktree, branch e banco do slot

Acompanhamento
  status                  tabela das tarefas
`;

function tabelaStatus(ctx) {
  const estados = Object.fromEntries(listarEstados(ctx).map((e) => [e.id, e]));
  const linhas = listarTarefas(ctx.dirs.tasks).map((t) => {
    const e = estados[t.id] || { status: STATUS.NOVA };
    const ult = e.historico?.at(-1);
    return {
      id: t.id,
      onda: t.onda,
      tam: t.tamanho,
      status: e.status,
      slot: e.slot ?? '-',
      modelo: e.modelos?.[e.modeloIdx] ?? '-',
      portao: e.falhasPortao ?? 0,
      reprov: e.reprovacoes ?? 0,
      ultimo: ult ? `${ult.evento} ${new Date(ult.em).toTimeString().slice(0, 5)}` : '-',
    };
  });
  if (linhas.length === 0) return 'Nenhuma tarefa em .factory/tasks/.';
  const cols = Object.keys(linhas[0]);
  const larg = cols.map((c) => Math.max(c.length, ...linhas.map((l) => String(l[c]).length)));
  const fmt = (vals) => vals.map((v, i) => String(v).padEnd(larg[i])).join('  ');
  return [fmt(cols), fmt(larg.map((n) => '-'.repeat(n))), ...linhas.map((l) => fmt(cols.map((c) => l[c])))].join('\n');
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || ['help', '-h', '--help'].includes(cmd)) {
    console.log(AJUDA);
    return 0;
  }
  const ctx = await carregarContexto();
  const id = args[0];
  const exigirId = () => {
    if (!id) throw new FabError(`Uso: fab ${cmd} <id>`);
    return id;
  };

  switch (cmd) {
    case 'doctor':
      return (await doctor(ctx)) ? 0 : 1;
    case 'plan-check':
      return (await verificarPlano(ctx)) ? 0 : 1;
    case 'status':
      console.log(tabelaStatus(ctx));
      return 0;
    case 'new':
      await criarWorktree(ctx, lerTarefa(ctx.dirs.tasks, exigirId()));
      return 0;
    case 'task': {
      const s = await executarTarefa(ctx, exigirId(), { forcar: args.includes('--force') });
      return s === STATUS.AGUARDANDO ? 0 : 2;
    }
    case 'retry':
      await liberarParaNovaTentativa(ctx, exigirId(), { resetarModelo: args.includes('--reset-model') });
      return (await executarTarefa(ctx, id)) === STATUS.AGUARDANDO ? 0 : 2;
    case 'wave': {
      const n = Number(exigirId());
      const res = await executarOnda(ctx, n);
      console.log('\n' + tabelaStatus(ctx));
      return Object.values(res).every((s) => s === STATUS.AGUARDANDO) ? 0 : 2;
    }
    case 'gate': {
      const t = lerTarefa(ctx.dirs.tasks, exigirId());
      const est = lerEstado(ctx, id);
      if (!est.worktree) throw new FabError(`${id} não tem worktree. Rode fab new ${id}.`);
      const r = await rodarPortao(ctx, t, est);
      registrar(est, 'portao-manual', { ok: r.ok });
      gravarEstado(ctx, est);
      if (!r.ok) console.log('\n' + r.feedback);
      return r.ok ? 0 : 1;
    }
    case 'review': {
      const t = lerTarefa(ctx.dirs.tasks, exigirId());
      const est = lerEstado(ctx, id);
      const r = await rodarRevisao(ctx, t, est);
      if (r.tipo === 'aprovado') {
        est.status = STATUS.AGUARDANDO;
        gravarEstado(ctx, est);
      }
      console.log(`${r.tipo}. Veja ${path.join('.factory/reviews', `${id}.md`)}`);
      return r.tipo === 'aprovado' ? 0 : 1;
    }
    case 'approve':
      await aprovar(ctx, exigirId());
      return 0;
    case 'reject':
      if (!args[1]) throw new FabError('Uso: fab reject <id> "motivo"');
      reprovar(ctx, id, args.slice(1).join(' '));
      return 0;
    case 'discard':
      await descartar(ctx, exigirId());
      return 0;
    case 'sync':
      await rebaseAbertos(ctx);
      return 0;
    default:
      console.log(AJUDA);
      return 1;
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((e) => {
    if (e instanceof FabError || e instanceof Pausa) log.erro(null, e.message);
    else console.error(e);
    process.exit(1);
  });
