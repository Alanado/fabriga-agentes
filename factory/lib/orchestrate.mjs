// Ciclo de vida de uma tarefa e das ondas: construtor → portão → validador → aguardando você.
import fs from 'node:fs';
import path from 'node:path';
import { git, existe, sleep, log, falhar, criarMutex, mkdirp, cauda } from './util.mjs';
import { lerTarefa, listarTarefas } from './task.mjs';
import { lerEstado, gravarEstado, registrar, listarEstados, STATUS, ATIVOS, slotsLivres } from './state.mjs';
import { criarWorktree, removerWorktree, resetarBanco, calcularBase } from './worktree.mjs';
import { cadeiaDeModelos, rodarConstrutor } from './agents.mjs';
import { rodarPortao } from './gate.mjs';
import { rodarRevisao } from './review.mjs';

const mutexRepo = criarMutex();

export class Pausa extends Error {}

function trocarModelo(ctx, est, motivo) {
  if (est.trocas >= ctx.profile.limits.modelSwitches || est.modeloIdx + 1 >= est.modelos.length) return false;
  est.modeloIdx += 1;
  est.trocas += 1;
  est.sessao = null;
  est.falhasPortao = 0;
  est.reprovacoes = 0;
  registrar(est, 'troca-de-modelo', { motivo, para: est.modelos[est.modeloIdx] });
  log.aviso(est.id, `trocando para ${est.modelos[est.modeloIdx]} (${motivo})`);
  return true;
}

function bloquear(ctx, est, motivo, feedback) {
  est.status = STATUS.BLOQUEADA;
  est.feedbackPendente = feedback;
  registrar(est, 'bloqueada', { motivo });
  gravarEstado(ctx, est);
  log.erro(est.id, `bloqueada: ${motivo}. Veja .factory/state/${est.id}.json e decida (fab retry, fab discard).`);
  return est.status;
}

function dependenciasPendentes(ctx, tarefa) {
  return tarefa.dependeDe.filter((d) => lerEstado(ctx, d).status !== STATUS.MERGEADA);
}

/**
 * Executa uma tarefa até ficar aguardando aprovação, bloqueada ou pausada.
 * Lança Pausa quando a conta do Claude bate o limite.
 */
export async function executarTarefa(ctx, id, { forcar = false } = {}) {
  const tarefa = lerTarefa(ctx.dirs.tasks, id);
  let est = lerEstado(ctx, id);
  if (est.status === STATUS.DESCARTADA) {
    // Tarefa descartada volta do zero (mantendo o histórico) em vez de ficar presa.
    Object.assign(est, {
      status: STATUS.NOVA, slot: null, worktree: null, branch: null, base: null,
      modelos: [], modeloIdx: 0, trocas: 0, falhasPortao: 0, reprovacoes: 0,
      sessao: null, feedbackPendente: null,
    });
    registrar(est, 'recriada');
    gravarEstado(ctx, est);
    log.info(id, 'estava descartada; estado reiniciado como nova');
  }
  if (est.status === STATUS.MERGEADA && !forcar) {
    log.info(id, `já está ${est.status}; nada a fazer`);
    return est.status;
  }
  if (est.status === STATUS.AGUARDANDO && !forcar) {
    log.info(id, 'já aprovada pelo validador; aguardando você (fab approve)');
    return est.status;
  }
  const pendentes = dependenciasPendentes(ctx, tarefa);
  if (pendentes.length && !forcar) falhar(`${id} depende de tarefas ainda não mergeadas: ${pendentes.join(', ')}`);
  // Os testes de aceite precisam estar commitados na main (em .factory/acceptance/<id>/): o worktree nasce dela.
  for (const f of tarefa.aceite) {
    const r = await git(['cat-file', '-e', `${ctx.profile.mainBranch}:.factory/acceptance/${id}/${f}`], ctx.raiz, { permitirFalha: true });
    if (r.code !== 0) falhar(`${id}: ".factory/acceptance/${id}/${f}" não está commitado em ${ctx.profile.mainBranch}. Commite os testes de aceite antes de rodar a tarefa.`);
  }

  est = await mutexRepo(() => criarWorktree(ctx, tarefa));
  if (ctx.profile.compose?.enabled && ctx.profile.compose.resetEachTask) await resetarBanco(ctx, est);

  if (!est.modelos?.length) est.modelos = cadeiaDeModelos(ctx, tarefa, est.slot);
  const limites = { ...ctx.profile.limits, ...(tarefa.tentativasMax ? { reviewRetries: tarefa.tentativasMax } : {}) };
  // Pausada depois de o portão passar (limite no validador): retoma direto no portão, sem gastar o construtor.
  const ultimoPortao = [...est.historico].reverse().find((h) => h.evento === 'portao');
  let pularConstrutor = est.status === STATUS.PAUSADA && !est.feedbackPendente && ultimoPortao?.ok === true;
  est.status = STATUS.EM_ANDAMENTO;
  let feedback = est.feedbackPendente || null;
  let retomar = Boolean(feedback && est.sessao);
  est.feedbackPendente = null;
  let transitorios = 0;
  gravarEstado(ctx, est);

  for (;;) {
    const modelo = est.modelos[est.modeloIdx];
    let r;
    if (pularConstrutor) {
      pularConstrutor = false;
      log.info(id, 'retomando após pausa: direto para o portão');
      r = { tipo: 'pulado' };
    } else {
      log.info(id, `construtor ${modelo}${retomar ? ' (continuando sessão)' : ''}`);
      r = await rodarConstrutor(ctx, tarefa, est, { modelo, feedback, retomar });
    }
    if (r.tipo !== 'pulado') {
      registrar(est, 'agente', { modelo, tipo: r.tipo, custo: r.custo, turnos: r.turnos, log: path.relative(ctx.raiz, r.log) });
      if (r.sessao) est.sessao = r.sessao;
      gravarEstado(ctx, est);

      if (r.tipo === 'limite') {
        est.status = STATUS.PAUSADA;
        est.feedbackPendente = feedback;
        gravarEstado(ctx, est);
        throw new Pausa(`Limite da conta do Claude atingido durante ${id}.`);
      }
      if (r.tipo === 'config') return bloquear(ctx, est, `erro de autenticação ou configuração do modelo ${modelo}`, feedback);
      if (r.tipo === 'transitorio') {
        transitorios += 1;
        if (transitorios > ctx.profile.limits.transientRetries) {
          transitorios = 0;
          if (!trocarModelo(ctx, est, 'erros seguidos do provedor')) return bloquear(ctx, est, 'provedor indisponível em todos os modelos', feedback);
          retomar = false;
          continue;
        }
        const espera = 15_000 * 2 ** (transitorios - 1) + Math.floor(Math.random() * 5000);
        log.aviso(id, `erro temporário do provedor; nova tentativa em ${Math.round(espera / 1000)} s`);
        await sleep(espera);
        continue;
      }
      transitorios = 0;

      // Pedido de ampliação de recorte: o agente escreveu .factory-request.md e parou.
      const pedido = path.join(est.worktree, '.factory-request.md');
      if (existe(pedido)) {
        mkdirp(ctx.dirs.requests);
        fs.renameSync(pedido, path.join(ctx.dirs.requests, `${id}.md`));
        est.status = STATUS.PEDIDO;
        registrar(est, 'pedido-de-recorte');
        gravarEstado(ctx, est);
        log.aviso(id, `o agente pediu arquivos fora do recorte: .factory/requests/${id}.md. Atualize o pacote e rode fab retry ${id}.`);
        return est.status;
      }
    }

    const portao = await rodarPortao(ctx, tarefa, est);
    registrar(est, 'portao', { ok: portao.ok, passo: portao.passos.at(-1)?.nome });
    if (!portao.ok) {
      est.falhasPortao += 1;
      feedback = portao.feedback;
      retomar = true;
      if (est.falhasPortao >= limites.gateRetries) {
        if (!trocarModelo(ctx, est, `${est.falhasPortao} falhas no portão`)) {
          return bloquear(ctx, est, `portão reprovou ${limites.gateRetries} vezes também no último modelo`, feedback);
        }
        retomar = false;
      }
      gravarEstado(ctx, est);
      continue;
    }

    const rev = await rodarRevisao(ctx, tarefa, est);
    registrar(est, 'revisao', { tipo: rev.tipo });
    if (rev.tipo === 'limite') {
      est.status = STATUS.PAUSADA;
      gravarEstado(ctx, est);
      throw new Pausa(`Limite da conta do Claude atingido ao validar ${id}.`);
    }
    if (rev.tipo === 'erro') return bloquear(ctx, est, 'o validador não respondeu no formato esperado', rev.feedback);
    if (rev.tipo === 'aprovado') {
      est.status = STATUS.AGUARDANDO;
      gravarEstado(ctx, est);
      log.ok(id, `validada. Leia .factory/reviews/${id}.md e rode: fab approve ${id}`);
      return est.status;
    }
    est.reprovacoes += 1;
    feedback = rev.feedback;
    retomar = true;
    log.erro(id, `validador reprovou (${est.reprovacoes}/${limites.reviewRetries})`);
    if (est.reprovacoes >= limites.reviewRetries) {
      if (!trocarModelo(ctx, est, `${est.reprovacoes} reprovações do validador`)) {
        return bloquear(ctx, est, `validador reprovou ${limites.reviewRetries} vezes também no último modelo`, feedback);
      }
      retomar = false;
    }
    gravarEstado(ctx, est);
  }
}

/** Roda todas as tarefas pendentes de uma onda, até `slots` em paralelo. */
export async function executarOnda(ctx, onda) {
  const todas = listarTarefas(ctx.dirs.tasks).filter((t) => t.onda === onda);
  if (todas.length === 0) falhar(`Nenhuma tarefa na onda ${onda}.`);
  const fila = todas.filter((t) => {
    const s = lerEstado(ctx, t.id).status;
    if ([STATUS.MERGEADA, STATUS.DESCARTADA, STATUS.AGUARDANDO].includes(s)) return false;
    if ([STATUS.BLOQUEADA, STATUS.PEDIDO, STATUS.CONFLITO, STATUS.REPROVADA_HUMANO].includes(s)) {
      log.aviso(t.id, `pulada: está "${s}" e precisa de você (fab retry ${t.id} quando estiver pronta)`);
      return false;
    }
    const pend = dependenciasPendentes(ctx, t);
    if (pend.length) {
      log.aviso(t.id, `pulada: depende de ${pend.join(', ')}`);
      return false;
    }
    return true;
  });
  log.info(null, `onda ${onda}: ${fila.length} tarefa(s) para rodar, ${ctx.profile.slots} slot(s)`);
  const resultados = {};
  let pausado = false;
  if (fila.length === 0) return resultados;
  // Slots ocupados por tarefas de fora da fila (ex.: aguardando sua aprovação) não podem ser usados.
  const vagas = Math.min(ctx.profile.slots, slotsLivres(ctx) + fila.filter((t) => lerEstado(ctx, t.id).worktree).length);
  if (vagas === 0) falhar('Nenhum slot livre: aprove ou descarte tarefas abertas (fab status).');

  const trabalhador = async () => {
    while (fila.length && !pausado) {
      const t = fila.shift();
      try {
        resultados[t.id] = await executarTarefa(ctx, t.id);
      } catch (e) {
        if (e instanceof Pausa) {
          pausado = true;
          resultados[t.id] = STATUS.PAUSADA;
          log.aviso(t.id, `${e.message} A fila parou; rode "fab wave ${onda}" de novo depois que o limite renovar.`);
        } else {
          resultados[t.id] = `erro: ${e.message.split('\n')[0]}`;
          log.erro(t.id, e.message);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(vagas, fila.length) }, trabalhador));
  return resultados;
}

/** Commit no branch, merge --no-ff na main, limpeza e rebase dos worktrees abertos. */
export async function aprovar(ctx, id) {
  const tarefa = lerTarefa(ctx.dirs.tasks, id);
  const est = lerEstado(ctx, id);
  if (est.status !== STATUS.AGUARDANDO) falhar(`${id} está "${est.status}"; só tarefas aguardando aprovação podem ser mergeadas.`);
  const main = ctx.profile.mainBranch;

  await mutexRepo(async () => {
    const atual = await git(['rev-parse', '--abbrev-ref', 'HEAD'], ctx.raiz);
    if (atual !== main) falhar(`O repositório principal está em "${atual}". Volte para "${main}" antes de aprovar.`);
    const sujo = await git(['status', '--porcelain', '--untracked-files=no'], ctx.raiz);
    if (sujo) falhar(`O repositório principal tem alterações não commitadas:\n${sujo}`);

    await git(['add', '--all'], est.worktree);
    const temMudanca = (await git(['diff', '--cached', '--quiet'], est.worktree, { permitirFalha: true })).code !== 0;
    if (temMudanca) await git(['commit', '-m', `feat(${id}): ${tarefa.titulo || id}`], est.worktree);
    await git(['merge', '--no-ff', est.branch, '-m', `merge: ${id} ${tarefa.titulo}`.trim()], ctx.raiz);
    registrar(est, 'mergeada');
    gravarEstado(ctx, est);
    log.ok(id, `mergeada em ${main}`);
  });
  await removerWorktree(ctx, id);
  await rebaseAbertos(ctx);
}

/** Depois de um merge, traz a main para os worktrees ainda abertos e roda o portão de novo onde já tinha passado. */
export async function rebaseAbertos(ctx) {
  const main = ctx.profile.mainBranch;
  for (const est of listarEstados(ctx)) {
    if (!ATIVOS.has(est.status) || !est.worktree || !existe(est.worktree)) continue;
    // O trabalho do construtor não está commitado. Um commit temporário atravessa o rebase
    // (git stash não lida com arquivos "intent-to-add") e depois é desfeito.
    await git(['add', '--all'], est.worktree);
    const temWip = (await git(['diff', '--cached', '--quiet'], est.worktree, { permitirFalha: true })).code !== 0;
    if (temWip) await git(['commit', '--no-verify', '-m', `wip(${est.id}): sincronização da fábrica`], est.worktree);
    const desfazerWip = async () => {
      if (!temWip) return;
      await git(['reset', '--soft', 'HEAD~1'], est.worktree);
      await git(['reset', '-q'], est.worktree, { permitirFalha: true });
    };
    const r = await git(['rebase', main], est.worktree, { permitirFalha: true });
    if (r.code !== 0) {
      await git(['rebase', '--abort'], est.worktree, { permitirFalha: true });
      await desfazerWip();
      est.status = STATUS.CONFLITO;
      est.feedbackPendente = `## Conflito com a main\n\nA main recebeu outra feature e o rebase deste branch conflitou:\n\n${cauda(r.stdout + r.stderr, 30)}`;
      registrar(est, 'conflito-no-rebase');
      gravarEstado(ctx, est);
      log.erro(est.id, 'conflito ao trazer a main. Rode "fab retry" para o agente resolver, ou resolva à mão.');
      continue;
    }
    await desfazerWip();
    const tarefa = lerTarefa(ctx.dirs.tasks, est.id);
    est.base = await calcularBase(ctx, tarefa, est.worktree);
    registrar(est, 'rebase', { base: est.base });
    if (est.status === STATUS.AGUARDANDO) {
      const portao = await rodarPortao(ctx, tarefa, est);
      if (!portao.ok) {
        est.status = STATUS.EM_ANDAMENTO;
        est.feedbackPendente = `${portao.feedback}\n\n(Isso começou a falhar depois que a main recebeu outra feature.)`;
        log.aviso(est.id, 'portão falhou depois do rebase; rode "fab retry" para corrigir');
      }
    }
    gravarEstado(ctx, est);
    log.ok(est.id, 'atualizada com a main');
  }
}

/** Você reprovou: o motivo vira feedback e conta como reprovação do validador. */
export function reprovar(ctx, id, motivo) {
  const est = lerEstado(ctx, id);
  if (!est.worktree) falhar(`${id} não tem worktree aberto.`);
  est.status = STATUS.REPROVADA_HUMANO;
  est.reprovacoes += 1;
  est.feedbackPendente = `## Reprovado pelo revisor humano\n\n${motivo}`;
  registrar(est, 'reprovada-por-voce', { motivo });
  gravarEstado(ctx, est);
  log.ok(id, `reprovada. Rode "fab retry ${id}" para o agente corrigir.`);
}

/**
 * Libera uma tarefa bloqueada/pausada/em conflito para rodar de novo, zerando contadores.
 * Em conflito, o trabalho é refeito sobre a main nova (o agente não pode rodar rebase).
 */
export async function liberarParaNovaTentativa(ctx, id, { resetarModelo = false } = {}) {
  const est = lerEstado(ctx, id);
  if (est.status === STATUS.CONFLITO && est.worktree && existe(est.worktree)) {
    await git(['reset', '--hard', est.base], est.worktree);
    await git(['clean', '-fdq'], est.worktree);
    const r = await git(['rebase', ctx.profile.mainBranch], est.worktree, { permitirFalha: true });
    if (r.code !== 0) {
      await git(['rebase', '--abort'], est.worktree, { permitirFalha: true });
      falhar(`${id}: nem os testes de aceite aplicam sobre a main nova. Descarte (fab discard ${id}) e replaneje.`);
    }
    est.base = await calcularBase(ctx, lerTarefa(ctx.dirs.tasks, id), est.worktree);
    est.sessao = null;
    est.feedbackPendente = 'A main mudou e o trabalho anterior conflitou. Refaça a tarefa do zero sobre o código atual.';
    log.info(id, 'worktree refeito sobre a main nova');
  }
  est.status = STATUS.EM_ANDAMENTO;
  est.falhasPortao = 0;
  if (resetarModelo) {
    est.modeloIdx = 0;
    est.trocas = 0;
    est.modelos = [];
    est.sessao = null;
  }
  registrar(est, 'nova-tentativa');
  gravarEstado(ctx, est);
}

export async function descartar(ctx, id) {
  await mutexRepo(() => removerWorktree(ctx, id, { descartar: true }));
  log.ok(id, 'descartada: worktree, branch e banco do slot removidos');
}
