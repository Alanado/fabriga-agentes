// Estado das tarefas e travas de slot em .factory/state/.
import fs from 'node:fs';
import path from 'node:path';
import { lerJSON, gravarJSON, mkdirp, falhar } from './util.mjs';

export const STATUS = {
  NOVA: 'nova',
  EM_ANDAMENTO: 'em-andamento',
  AGUARDANDO: 'aguardando-aprovacao',
  BLOQUEADA: 'bloqueada',
  PAUSADA: 'pausada-limite',
  CONFLITO: 'conflito',
  PEDIDO: 'pedido-de-recorte',
  REPROVADA_HUMANO: 'reprovada-por-voce',
  MERGEADA: 'mergeada',
  DESCARTADA: 'descartada',
};

/** Status em que a tarefa ainda ocupa um worktree. */
export const ATIVOS = new Set([
  STATUS.EM_ANDAMENTO, STATUS.AGUARDANDO, STATUS.BLOQUEADA, STATUS.PAUSADA,
  STATUS.CONFLITO, STATUS.PEDIDO, STATUS.REPROVADA_HUMANO,
]);

const arqEstado = (ctx, id) => path.join(ctx.dirs.state, `${id}.json`);

export function lerEstado(ctx, id) {
  return lerJSON(arqEstado(ctx, id), {
    id,
    status: STATUS.NOVA,
    slot: null,
    worktree: null,
    branch: null,
    base: null,
    modelos: [],
    modeloIdx: 0,
    trocas: 0,
    falhasPortao: 0,
    reprovacoes: 0,
    sessao: null,
    feedbackPendente: null,
    historico: [],
  });
}

export function gravarEstado(ctx, est) {
  est.atualizadoEm = new Date().toISOString();
  gravarJSON(arqEstado(ctx, est.id), est);
  return est;
}

export function registrar(est, evento, detalhe = {}) {
  est.historico.push({ em: new Date().toISOString(), evento, ...detalhe });
}

export function listarEstados(ctx) {
  if (!fs.existsSync(ctx.dirs.state)) return [];
  return fs
    .readdirSync(ctx.dirs.state)
    .filter((f) => f.endsWith('.json'))
    .map((f) => lerJSON(path.join(ctx.dirs.state, f)));
}

// ---- travas de slot (arquivo criado com 'wx' = atômico) ----
const dirSlots = (ctx) => path.join(ctx.dirs.state, 'slots');

export function ocuparSlot(ctx, id, preferido = null) {
  mkdirp(dirSlots(ctx));
  const ordem = [];
  if (preferido) ordem.push(preferido);
  for (let s = 1; s <= ctx.profile.slots; s++) if (s !== preferido) ordem.push(s);
  for (const s of ordem) {
    const arq = path.join(dirSlots(ctx), `slot${s}.lock`);
    try {
      const fd = fs.openSync(arq, 'wx');
      fs.writeSync(fd, id);
      fs.closeSync(fd);
      return s;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (fs.readFileSync(arq, 'utf8').trim() === id) return s;
    }
  }
  falhar(`Todos os ${ctx.profile.slots} slots estão ocupados. Aprove, descarte ou limpe uma tarefa antes.`);
}

export function liberarSlot(ctx, slot, id) {
  if (!slot) return;
  const arq = path.join(dirSlots(ctx), `slot${slot}.lock`);
  if (fs.existsSync(arq) && fs.readFileSync(arq, 'utf8').trim() === id) fs.unlinkSync(arq);
}

export function slotsLivres(ctx) {
  let livres = 0;
  for (let s = 1; s <= ctx.profile.slots; s++) {
    if (!fs.existsSync(path.join(dirSlots(ctx), `slot${s}.lock`))) livres++;
  }
  return livres;
}
