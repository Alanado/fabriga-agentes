// Portão automático: escopo, testes de aceite intocados, atalhos proibidos, verify e cobertura dos critérios.
import fs from 'node:fs';
import path from 'node:path';
import {
  git, sh, existe, gravarJSON, gravarTexto, mkdirp, cauda, casaAlgum, preencher, log,
} from './util.mjs';
import { ambienteDoWorktree } from './worktree.mjs';

/** Arquivos alterados em relação à base (inclui novos, ignorando os excluídos). */
export async function arquivosAlterados(est) {
  await git(['add', '--intent-to-add', '--all'], est.worktree, { permitirFalha: true });
  const nomes = await git(['diff', '--name-only', est.base], est.worktree);
  return nomes.split('\n').filter(Boolean);
}

/** Mensagem do passo "escopo". O portão compara com a base, então o diff precisa citá-la (inclui commits do construtor). */
export function mensagemEscopo(violacoes, base) {
  return `Desfaça as alterações nestes arquivos. O portão compara com a base da tarefa e conta também os commits que você já fez; para ver a diferença use \`git diff --stat ${base}\` e \`git diff ${base} -- <arquivo>\` (\`git diff\` sem argumento não mostra o que já foi commitado):\n${violacoes.join('\n')}\n\nSe precisar mesmo de um arquivo fora do recorte, escreva o pedido em .factory-request.md e encerre.`;
}

function testesDoRelatorio(json) {
  const testes = [];
  const andar = (no, ancestrais) => {
    if (Array.isArray(no)) return no.forEach((x) => andar(x, ancestrais));
    if (!no || typeof no !== 'object') return;
    const titulo = typeof no.fullName === 'string' ? no.fullName : typeof no.title === 'string' ? no.title : null;
    const caminho = titulo ? [...ancestrais, titulo] : ancestrais;
    const status = no.status ?? (typeof no.ok === 'boolean' ? (no.ok ? 'passed' : 'failed') : undefined);
    if (titulo && typeof status === 'string' && !Array.isArray(no.suites) && !Array.isArray(no.specs)) {
      const passou = ['passed', 'expected', 'pass', 'ok'].includes(status);
      const falhou = ['failed', 'unexpected', 'fail', 'timedOut', 'interrupted'].includes(status);
      if (passou || falhou) testes.push({ titulo: caminho.join(' › '), passou });
    }
    for (const v of Object.values(no)) if (v && typeof v === 'object') andar(v, caminho);
  };
  andar(json, []);
  return testes;
}

function copiarScreenshots(origem, destino, limite = 20) {
  if (!existe(origem)) return [];
  const achados = [];
  const visitar = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (achados.length >= limite) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visitar(p);
      else if (/\.(png|jpe?g)$/i.test(e.name)) achados.push(p);
    }
  };
  visitar(origem);
  mkdirp(destino);
  return achados.map((p, i) => {
    const nome = `${String(i + 1).padStart(2, '0')}-${path.basename(path.dirname(p))}-${path.basename(p)}`.slice(-120);
    fs.copyFileSync(p, path.join(destino, nome));
    return nome;
  });
}

/**
 * Roda o portão. Retorna { ok, passos, feedback, arquivos }.
 * Não gasta tokens: tudo aqui é determinístico.
 */
export async function rodarPortao(ctx, tarefa, est) {
  const g = ctx.profile.gate;
  const ev = path.join(ctx.dirs.evidence, tarefa.id);
  fs.rmSync(ev, { recursive: true, force: true });
  mkdirp(ev);
  const env = ambienteDoWorktree(ctx, est);
  const passos = [];
  let feedback = null;
  const passo = async (nome, fn) => {
    if (feedback) return;
    const t0 = Date.now();
    const r = await fn();
    passos.push({ nome, ok: r.ok, detalhe: r.detalhe || '', duracaoMs: Date.now() - t0 });
    if (!r.ok) feedback = `## Portão reprovou no passo "${nome}"\n\n${r.detalhe}`;
  };

  const arquivos = await arquivosAlterados(est);
  const proibidos = [...g.alwaysForbidden, ...tarefa.proibidos, ...tarefa.aceite];

  await passo('alteracoes', async () =>
    arquivos.length ? { ok: true, detalhe: `${arquivos.length} arquivo(s)` } : { ok: false, detalhe: 'Nenhum arquivo foi alterado.' });

  await passo('escopo', async () => {
    const violacoes = [];
    for (const f of arquivos) {
      if (casaAlgum(f, proibidos)) violacoes.push(`- ${f}: arquivo proibido (testes de aceite, .factory, configuração)`);
      else if (!casaAlgum(f, tarefa.permitidos)) violacoes.push(`- ${f}: fora de "Permitido alterar"`);
    }
    return violacoes.length
      ? { ok: false, detalhe: mensagemEscopo(violacoes, est.base) }
      : { ok: true };
  });

  const patch = await git(['diff', est.base], est.worktree);
  gravarTexto(path.join(ev, 'diff.patch'), patch);
  gravarTexto(path.join(ev, 'diffstat.txt'), await git(['diff', '--stat', est.base], est.worktree));

  await passo('atalhos', async () => {
    const regex = g.forbiddenPatterns.map((p) => new RegExp(p));
    const achados = [];
    let atual = '';
    for (const linha of patch.split('\n')) {
      if (linha.startsWith('+++ ')) atual = linha.replace(/^\+\+\+ (b\/)?/, '');
      else if (linha.startsWith('+') && regex.some((r) => r.test(linha))) achados.push(`- ${atual}: ${linha.slice(1).trim().slice(0, 120)}`);
    }
    return achados.length
      ? { ok: false, detalhe: `Remova estes atalhos (testes pulados ou checagens desligadas não são aceitos):\n${achados.join('\n')}` }
      : { ok: true };
  });

  await passo('instalacao', async () => {
    const precisa = arquivos.some((f) => /(^|\/)(package-lock\.json|package\.json)$/.test(f)) || !existe(path.join(est.worktree, 'node_modules'));
    if (!precisa || !g.install) return { ok: true, detalhe: 'sem mudança de dependências' };
    const r = await sh(g.install, { cwd: est.worktree, env, logFile: path.join(ev, 'install.log'), timeoutMs: g.timeoutMin * 60_000 });
    return r.code === 0 ? { ok: true } : { ok: false, detalhe: `"${g.install}" falhou:\n\n${cauda(r.stdout + r.stderr, g.logTailLines)}` };
  });

  await passo('verify', async () => {
    const r = await sh(g.verify, { cwd: est.worktree, env, logFile: path.join(ev, 'verify.log'), timeoutMs: g.timeoutMin * 60_000 });
    if (r.timedOut) return { ok: false, detalhe: `"${g.verify}" passou de ${g.timeoutMin} min e foi interrompido.` };
    return r.code === 0 ? { ok: true } : { ok: false, detalhe: `"${g.verify}" falhou (últimas linhas):\n\n${cauda(r.stdout + '\n' + r.stderr, g.logTailLines)}` };
  });

  await passo('criterios', async () => {
    if (!g.acceptance || tarefa.aceite.length === 0) return { ok: true, detalhe: 'sem comando de aceite configurado' };
    const relatorio = path.join(ev, 'acceptance.json');
    const cmd = preencher(g.acceptance, { files: tarefa.aceite.join(' '), report: relatorio });
    const r = await sh(cmd, { cwd: est.worktree, env, logFile: path.join(ev, 'acceptance.log'), timeoutMs: g.timeoutMin * 60_000 });
    let testes = [];
    if (existe(relatorio)) {
      try {
        testes = testesDoRelatorio(JSON.parse(fs.readFileSync(relatorio, 'utf8')));
      } catch {
        /* relatório inválido: tratado abaixo */
      }
    }
    if (r.code !== 0) {
      const falhos = testes.filter((t) => !t.passou).map((t) => `- ${t.titulo}`);
      return { ok: false, detalhe: `Testes de aceite falharam:\n${falhos.join('\n') || cauda(r.stdout + r.stderr, g.logTailLines)}` };
    }
    const faltando = tarefa.criterios.filter((ca) => !testes.some((t) => t.passou && new RegExp(`\\b${ca}\\b`).test(t.titulo)));
    return faltando.length
      ? { ok: false, detalhe: `Nenhum teste aprovado cobre: ${faltando.join(', ')}. (Os títulos dos testes de aceite devem conter o id do critério.)` }
      : { ok: true, detalhe: `${tarefa.criterios.length} critério(s) cobertos` };
  });

  const screenshots = copiarScreenshots(path.join(est.worktree, g.screenshotsDir), path.join(ev, 'screenshots'));
  const ok = !feedback;
  gravarJSON(path.join(ev, 'gate.json'), {
    id: tarefa.id, ok, quando: new Date().toISOString(), base: est.base, arquivos, screenshots, passos,
  });
  if (ok) log.ok(tarefa.id, `portão aprovado (${passos.map((p) => p.nome).join(', ')})`);
  else log.erro(tarefa.id, `portão reprovado em "${passos.at(-1).nome}"`);
  return { ok, passos, feedback, arquivos };
}
