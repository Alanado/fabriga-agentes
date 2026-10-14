// Disparo dos agentes construtores: Claude Code (perfil trabalho) ou OpenCode (perfil pessoal).
import path from 'node:path';
import { run, lerTexto, existe, gravarTexto, mkdirp, cauda, falhar } from './util.mjs';
import { dirRun, ambienteDoWorktree } from './worktree.mjs';

/** Cadeia de modelos para a tarefa, em ordem de troca. */
export function cadeiaDeModelos(ctx, tarefa, slot) {
  const m = ctx.models[ctx.profile.perfil];
  if (!m) falhar(`models.json não tem a chave "${ctx.profile.perfil}".`);
  const cadeia = ctx.profile.perfil === 'trabalho' ? m[tarefa.tamanho] : m[`slot${slot}`] || m.slot1;
  if (!Array.isArray(cadeia) || cadeia.length === 0) falhar(`models.json: cadeia vazia para ${tarefa.id}.`);
  return cadeia;
}

export function esforco(ctx, tarefa) {
  return ctx.models.trabalho?.effort?.[tarefa.tamanho] || 'medium';
}

function montarPrompt(ctx, tarefa, est, feedback, continuacao) {
  const verify = ctx.profile.gate.verify;
  if (continuacao) {
    return [
      'O portão automático ou o validador reprovou sua entrega. Corrija só o que está abaixo, dentro do mesmo recorte de arquivos.',
      '',
      feedback,
      '',
      `Quando terminar, rode \`${verify}\` e encerre com um resumo de até 5 linhas.`,
    ].join('\n');
  }
  return [
    `Você é o agente construtor da tarefa ${tarefa.id}. Seu diretório de trabalho é ${est.worktree}.`,
    'Siga o pacote de tarefa abaixo à risca. Ele é a única especificação.',
    '',
    '<pacote-de-tarefa>',
    tarefa.texto.trim(),
    '</pacote-de-tarefa>',
    ...(feedback ? ['', '## Correções pedidas na tentativa anterior', '', feedback] : []),
    '',
    `Quando terminar, rode \`${verify}\` e encerre com um resumo de até 5 linhas do que mudou.`,
  ].join('\n');
}

function classificar(texto, code, timedOut) {
  // Sucesso não é reclassificado pelo texto: o resumo do agente pode citar "500" ou "429" à toa.
  if (code === 0 && !timedOut) return 'ok';
  const t = String(texto);
  if (/hit your (session|weekly|opus|sonnet|usage) limit|usage limit reached|limit will reset/i.test(t)) return 'limite';
  if (/\b(401|403)\b|unauthori[sz]ed|invalid api key|authentication/i.test(t)) return 'config';
  if (/unrecognized flag|unknown (flag|option|argument)|invalid argument|model not found|modelo n[aã]o encontrado/i.test(t)) return 'config';
  if (/overloaded|rate.?limit|too many requests|\b429\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|socket hang up|network error/i.test(t)) return 'transitorio';
  if (timedOut) return 'ok';
  return code === 0 ? 'ok' : 'transitorio';
}

/**
 * Roda o construtor uma vez. Retorna { tipo: 'ok'|'transitorio'|'limite'|'config', sessao, resumo, log }.
 */
export async function rodarConstrutor(ctx, tarefa, est, { modelo, feedback, retomar }) {
  mkdirp(ctx.dirs.logs);
  const n = est.historico.filter((h) => h.evento === 'agente').length + 1;
  const logFile = path.join(ctx.dirs.logs, `${tarefa.id}-${String(n).padStart(2, '0')}.json`);
  const timeoutMs = ctx.profile.limits.agentTimeoutMin * 60_000;
  const continuacao = Boolean(retomar && est.sessao && ctx.profile.perfil === 'trabalho');
  const prompt = montarPrompt(ctx, tarefa, est, feedback, continuacao);
  const regras = path.join(ctx.dirs.templates, 'builder-rules.md');

  let r;
  if (ctx.profile.perfil === 'trabalho') {
    const args = [
      '-p', prompt,
      '--model', modelo,
      '--effort', esforco(ctx, tarefa),
      '--permission-mode', 'default',
      '--permission-prompts', 'none',
      '--settings', path.join(dirRun(ctx, tarefa.id), 'claude-settings.json'),
      '--max-turns', String(ctx.profile.limits.maxTurns),
      '--output-format', 'json',
    ];
    if (existe(regras)) args.push('--append-system-prompt-file', regras);
    if (continuacao) args.push('--resume', est.sessao);
    r = await run('claude', args, { cwd: est.worktree, env: ambienteDoWorktree(ctx, est), timeoutMs });
    gravarTexto(logFile, r.stdout || JSON.stringify({ stderr: r.stderr }));
    let saida = null;
    try {
      saida = JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      /* saída não-JSON: classifica pelo texto */
    }
    const texto = saida ? `${saida.result || ''} ${saida.subtype || ''}` : `${r.stdout} ${r.stderr}`;
    let tipo = classificar(texto, saida?.is_error ? 1 : r.code, r.timedOut);
    if (saida?.subtype === 'error_max_turns') tipo = 'ok';
    return {
      tipo,
      sessao: saida?.session_id || null,
      resumo: saida?.result ? cauda(saida.result, 8) : cauda(r.stderr || r.stdout, 8),
      custo: saida?.total_cost_usd ?? null,
      turnos: saida?.num_turns ?? null,
      log: logFile,
    };
  }

  // perfil pessoal: OpenCode com modelo gratuito; sempre sessão nova (os tokens não custam cota do Claude)
  // OpenCode não tem flag de system prompt adicional: as regras vão no começo do prompt.
  const promptOC = existe(regras) ? `${lerTexto(regras)}\n\n---\n\n${prompt}` : prompt;
  const args = ['run', promptOC, '--model', modelo, '--format', 'json', '--auto', '--title', tarefa.id];
  r = await run('opencode', args, {
    cwd: est.worktree,
    timeoutMs,
    env: {
      ...ambienteDoWorktree(ctx, est),
      OPENCODE_CONFIG: path.join(dirRun(ctx, tarefa.id), 'opencode.json'),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
    },
  });
  gravarTexto(logFile.replace(/\.json$/, '.jsonl'), r.stdout + (r.stderr ? `\n# stderr\n${r.stderr}` : ''));
  const tipo = classificar(`${cauda(r.stdout, 40)} ${r.stderr}`, r.code, r.timedOut);
  return { tipo, sessao: null, resumo: cauda(r.stderr || r.stdout, 8), custo: null, turnos: null, log: logFile };
}
