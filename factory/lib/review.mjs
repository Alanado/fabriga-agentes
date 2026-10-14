// Validação pelo Claude: sessão nova, só lê o pacote de revisão (tarefa, diff, gate.json, screenshots).
import fs from 'node:fs';
import path from 'node:path';
import { run, existe, lerTexto, gravarTexto, gravarJSON, mkdirp, cauda, log } from './util.mjs';

const SCHEMA = {
  type: 'object',
  properties: {
    aprovado: { type: 'boolean' },
    resumo: { type: 'string', description: '3 a 5 linhas para o humano ler antes do merge' },
    problemas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          arquivo: { type: 'string' },
          linha: { type: 'integer' },
          gravidade: { type: 'string', enum: ['bloqueia', 'importante', 'sugestao'] },
          problema: { type: 'string' },
          correcao: { type: 'string' },
        },
        required: ['arquivo', 'gravidade', 'problema'],
      },
    },
    criterios: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, atendido: { type: 'boolean' }, evidencia: { type: 'string' } },
        required: ['id', 'atendido'],
      },
    },
  },
  required: ['aprovado', 'resumo', 'problemas'],
};

function montarPacote(ctx, tarefa) {
  const ev = path.join(ctx.dirs.evidence, tarefa.id);
  const pacote = path.join(ev, 'revisao');
  fs.rmSync(pacote, { recursive: true, force: true });
  mkdirp(pacote);
  fs.copyFileSync(tarefa.arquivo, path.join(pacote, 'tarefa.md'));
  for (const f of ['diff.patch', 'diffstat.txt', 'gate.json']) {
    if (existe(path.join(ev, f))) fs.copyFileSync(path.join(ev, f), path.join(pacote, f));
  }
  const aceite = path.join(ctx.dirs.fab, 'acceptance', tarefa.id);
  if (existe(aceite)) fs.cpSync(aceite, path.join(pacote, 'aceite'), { recursive: true });
  if (existe(path.join(ev, 'screenshots'))) fs.cpSync(path.join(ev, 'screenshots'), path.join(pacote, 'screenshots'), { recursive: true });
  return pacote;
}

function paraMarkdown(tarefa, v, modelo) {
  const linhas = [
    `# Revisão ${tarefa.id}: ${tarefa.titulo}`,
    '',
    `**Veredito:** ${v.aprovado ? 'aprovado' : 'reprovado'} · ${new Date().toLocaleString('pt-BR')} · ${modelo}`,
    '',
    '## Resumo',
    '',
    v.resumo.trim(),
  ];
  if (v.criterios?.length) {
    linhas.push('', '## Critérios', '');
    for (const c of v.criterios) linhas.push(`- [${c.atendido ? 'x' : ' '}] ${c.id}${c.evidencia ? `: ${c.evidencia}` : ''}`);
  }
  if (v.problemas?.length) {
    linhas.push('', '## Problemas', '');
    for (const p of v.problemas) {
      linhas.push(`- **${p.gravidade}** \`${p.arquivo}${p.linha ? `:${p.linha}` : ''}\`: ${p.problema}${p.correcao ? ` Correção: ${p.correcao}` : ''}`);
    }
  }
  return linhas.join('\n') + '\n';
}

/** Retorna { tipo: 'aprovado'|'reprovado'|'limite'|'erro', feedback, veredito }. */
export async function rodarRevisao(ctx, tarefa, est) {
  const r = ctx.profile.review;
  const pacote = montarPacote(ctx, tarefa);
  const diffKb = existe(path.join(pacote, 'diff.patch')) ? fs.statSync(path.join(pacote, 'diff.patch')).size / 1024 : 0;
  if (diffKb > r.maxDiffKb) {
    return {
      tipo: 'reprovado',
      feedback: `## Validação recusada\n\nO diff tem ${Math.round(diffKb)} KB, acima do limite de ${r.maxDiffKb} KB. A tarefa é grande demais: o planejador deve quebrá-la.`,
      veredito: null,
    };
  }
  const regras = path.join(ctx.dirs.templates, 'reviewer-rules.md');
  const prompt = [
    `Valide a entrega da tarefa ${tarefa.id} ("${tarefa.titulo}").`,
    'Nesta pasta estão: tarefa.md (o pacote com os critérios de aceite), diff.patch, diffstat.txt, gate.json (resultado do portão automático, que já passou), aceite/ (os testes de aceite) e, se houver, screenshots/.',
    'Leia só esses arquivos. Responda no formato pedido.',
  ].join('\n');
  const args = [
    '-p', prompt,
    '--model', r.model,
    '--effort', r.effort,
    '--permission-mode', 'dontAsk',
    '--tools', 'Read,Glob,Grep',
    '--max-turns', String(r.maxTurns),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(SCHEMA),
    '--no-session-persistence',
  ];
  if (existe(regras)) args.push('--append-system-prompt-file', regras);
  log.info(tarefa.id, `validando com ${r.model}`);
  const res = await run('claude', args, { cwd: pacote, timeoutMs: 20 * 60_000 });
  gravarTexto(path.join(ctx.dirs.evidence, tarefa.id, 'review-raw.json'), res.stdout || res.stderr);
  let saida = null;
  try {
    saida = JSON.parse(res.stdout.trim().split('\n').pop());
  } catch {
    /* tratado abaixo */
  }
  const texto = saida ? String(saida.result || '') : `${res.stdout} ${res.stderr}`;
  if (/hit your (session|weekly|opus|sonnet|usage) limit|usage limit reached|limit will reset/i.test(texto)) {
    return { tipo: 'limite', feedback: null, veredito: null };
  }
  const v = saida?.structured_output;
  if (!v || typeof v.aprovado !== 'boolean') {
    return { tipo: 'erro', feedback: `Validador sem resposta estruturada:\n${cauda(texto, 20)}`, veredito: null };
  }
  // Problemas que bloqueiam sempre reprovam, mesmo que o modelo diga "aprovado".
  if (v.problemas?.some((p) => p.gravidade === 'bloqueia')) v.aprovado = false;
  if (v.criterios?.some((c) => !c.atendido)) v.aprovado = false;
  const md = paraMarkdown(tarefa, v, r.model);
  gravarTexto(path.join(ctx.dirs.reviews, `${tarefa.id}.md`), md);
  gravarJSON(path.join(ctx.dirs.evidence, tarefa.id, 'review.json'), v);
  return { tipo: v.aprovado ? 'aprovado' : 'reprovado', feedback: v.aprovado ? null : md, veredito: v };
}
