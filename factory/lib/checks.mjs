// fab doctor e fab plan-check.
import path from 'node:path';
import { run, sh, existe, lerTexto, prefixoLiteral, casaAlgum, preencher, log } from './util.mjs';
import { parseTarefa } from './task.mjs';
import { lerEstado, STATUS } from './state.mjs';
import fs from 'node:fs';

async function versao(cmd, args = ['--version']) {
  const r = await run(cmd, args);
  return r.code === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
}

export async function doctor(ctx) {
  const { profile: p, dirs } = ctx;
  let ok = true;
  const item = (passou, msg, dica = '') => {
    if (passou === 'aviso') log.aviso(null, `${msg}${dica ? ` → ${dica}` : ''}`);
    else if (passou) log.ok(null, msg);
    else {
      ok = false;
      log.erro(null, `${msg}${dica ? ` → ${dica}` : ''}`);
    }
  };

  item(true, `perfil: ${p.perfil}, ${p.slots} slot(s), worktrees em ${dirs.worktrees}`);
  const node = Number(process.versions.node.split('.')[0]);
  item(node >= 20, `node ${process.versions.node}`, 'use Node 20 ou mais novo');
  item(Boolean(await versao('git')), 'git instalado');
  const main = await run('git', ['rev-parse', '--verify', '--quiet', p.mainBranch], { cwd: ctx.raiz });
  item(main.code === 0, `branch principal "${p.mainBranch}" existe`, 'ajuste mainBranch no profile.json');

  const claude = await versao('claude');
  item(Boolean(claude), `claude: ${claude || 'não encontrado'}`, 'instale o Claude Code; ele valida nos dois perfis');
  if (claude) {
    const auth = await run('claude', ['auth', 'status']);
    let metodo = null;
    try {
      metodo = JSON.parse(auth.stdout).authMethod;
    } catch {
      /* versão antiga */
    }
    item(metodo ? metodo !== 'none' : 'aviso', `claude autenticado (${metodo || 'não consegui ler'})`, 'rode claude auth login');
  }
  if (p.perfil === 'pessoal') {
    const oc = await versao('opencode');
    item(Boolean(oc), `opencode: ${oc || 'não encontrado'}`, 'instale o OpenCode e conecte a NVIDIA (/connect)');
  }

  if (p.compose?.enabled) {
    const dc = await versao('docker', ['compose', 'version']);
    item(Boolean(dc), `docker compose: ${dc || 'não encontrado'}`, 'abra o Docker Desktop e ligue a integração com o WSL');
    const arq = path.join(ctx.raiz, p.compose.file);
    item(existe(arq), `${p.compose.file} existe`);
    if (existe(arq)) {
      const txt = lerTexto(arq);
      for (const [k, base] of Object.entries(p.env || {})) {
        if (txt.includes(`\${${k}`)) item(true, `${p.compose.file} usa \${${k}}`);
        else if (new RegExp(`["'\\s-]${base}:`).test(txt)) {
          item('aviso', `${p.compose.file} fixa a porta ${base}`, `os slots vão disputar a porta; troque "${base}:..." por "\${${k}:-${base}}:..."`);
        }
      }
    }
  }
  if (Object.keys(p.env || {}).length) {
    item(existe(path.join(ctx.raiz, '.env.example')) ? true : 'aviso', '.env.example existe', 'o .env do slot é gerado a partir dele');
  }
  const pkg = path.join(ctx.raiz, 'package.json');
  const mScript = p.gate.verify.match(/^npm run ([\w:-]+)/);
  if (mScript && existe(pkg)) {
    const scripts = JSON.parse(lerTexto(pkg)).scripts || {};
    item(Boolean(scripts[mScript[1]]), `script "${mScript[1]}" no package.json`, 'crie um script que rode lint, build e testes');
  }
  const gi = existe(path.join(ctx.raiz, '.gitignore')) ? lerTexto(path.join(ctx.raiz, '.gitignore')) : '';
  item(gi.includes('.factory/state') ? true : 'aviso', '.gitignore ignora .factory/state, logs e evidence', 'rode o install.sh de novo');
  for (const f of ['builder-rules.md', 'reviewer-rules.md']) item(existe(path.join(dirs.templates, f)), `template ${f}`);
  return ok;
}

const EXT_LINT = /\.(?:[cm]?[jt]sx?)$/;

function arquivosDeAceite(dir) {
  if (!existe(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && EXT_LINT.test(d.name))
    .map((d) => path.join(d.parentPath, d.name));
}

/** Roda o lint (gate.lintAcceptance) sobre os testes de aceite de uma tarefa; devolve as falhas "arquivo: regra". */
async function lintDeAceite(ctx, id) {
  const arquivos = arquivosDeAceite(path.join(ctx.dirs.fab, 'acceptance', id)).map((f) => path.relative(ctx.raiz, f));
  if (arquivos.length === 0) return [];
  const r = await sh(preencher(ctx.profile.gate.lintAcceptance, { files: arquivos.join(' ') }), { cwd: ctx.raiz });
  if (r.code === 0) return [];
  const falhas = [];
  let arquivo = null;
  for (const linha of (r.stdout || '').split('\n')) {
    if (/^\S/.test(linha) && !/^\s*\d+:\d+/.test(linha) && !/problems?\b/.test(linha)) {
      arquivo = path.relative(ctx.raiz, linha.trim());
      continue;
    }
    const m = linha.match(/^\s*(\d+):(\d+)\s+error\s+(.*?)\s{2,}(\S+)\s*$/) || linha.match(/^\s*(\d+):(\d+)\s+error\s+(.*)$/);
    if (m) falhas.push(`${arquivo ?? '?'}:${m[1]}:${m[2]} regra ${m[4] ?? '(sem regra: erro de análise)'}: ${m[3]}`);
  }
  if (falhas.length === 0) falhas.push(`lint falhou (código ${r.code}): ${(r.stdout + r.stderr).trim().slice(-400)}`);
  return falhas;
}

export async function verificarPlano(ctx) {
  const dir = ctx.dirs.tasks;
  let ok = true;
  const erro = (id, msg) => {
    ok = false;
    log.erro(id, msg);
  };
  const tarefas = [];
  for (const f of existe(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.md') && !x.startsWith('_')) : []) {
    try {
      const t = parseTarefa(lerTexto(path.join(dir, f)), f);
      if (`${t.id}.md` !== f) erro(t.id, `o arquivo deveria se chamar ${t.id}.md (está ${f})`);
      tarefas.push(t);
    } catch (e) {
      erro(f, e.message);
    }
  }
  if (tarefas.length === 0) {
    log.aviso(null, 'nenhuma tarefa em .factory/tasks/');
    return ok;
  }
  const porId = Object.fromEntries(tarefas.map((t) => [t.id, t]));
  const concluida = (t) => [STATUS.MERGEADA, STATUS.DESCARTADA].includes(lerEstado(ctx, t.id).status);
  for (const t of tarefas) {
    if (concluida(t)) continue;
    if (t.criterios.length === 0) erro(t.id, 'sem critérios de aceite numerados (CA1, CA2…)');
    if (t.aceite.length === 0) log.aviso(t.id, 'sem testes de aceite listados; o portão não terá como provar os critérios');
    for (const a of t.aceite) {
      if (!existe(path.join(ctx.dirs.fab, 'acceptance', t.id, a))) erro(t.id, `teste de aceite não existe: .factory/acceptance/${t.id}/${a}`);
      if (existe(path.join(ctx.raiz, a))) erro(t.id, `${a} já existe no projeto; o teste de aceite de uma tarefa nova deve ter caminho novo`);
      if (casaAlgum(a, t.permitidos)) erro(t.id, `o teste de aceite ${a} está dentro de "Permitido alterar"`);
    }
    if (ctx.profile.gate.lintAcceptance) {
      for (const f of await lintDeAceite(ctx, t.id)) erro(t.id, `lint do teste de aceite: ${f}`);
    }
    for (const c of t.contexto) if (!existe(path.join(ctx.raiz, c))) log.aviso(t.id, `arquivo de contexto não existe (ainda?): ${c}`);
    if (t.contexto.length > 10) log.aviso(t.id, `${t.contexto.length} arquivos de contexto: considere quebrar a tarefa`);
    for (const d of t.dependeDe) {
      if (!porId[d]) log.aviso(t.id, `depende de ${d}, que não tem pacote (ok se já foi mergeada)`);
      else if (porId[d].onda >= t.onda) erro(t.id, `depende de ${d}, que está na mesma onda ou depois`);
    }
  }
  const ondas = [...new Set(tarefas.map((t) => t.onda))].sort((a, b) => a - b);
  for (const n of ondas) {
    const daOnda = tarefas.filter((t) => t.onda === n && !concluida(t));
    if (daOnda.length === 0) continue;
    for (let i = 0; i < daOnda.length; i++) {
      for (let j = i + 1; j < daOnda.length; j++) {
        const a = daOnda[i];
        const b = daOnda[j];
        for (const ga of a.permitidos) {
          for (const gb of b.permitidos) {
            const pa = prefixoLiteral(ga);
            const pb = prefixoLiteral(gb);
            if (pa.startsWith(pb) || pb.startsWith(pa)) {
              erro(`${a.id}×${b.id}`, `onda ${n}: "${ga}" e "${gb}" podem tocar os mesmos arquivos. Mova o arquivo comum para a fase de contratos ou separe em ondas.`);
            }
          }
        }
      }
    }
    log.info(null, `onda ${n}: ${daOnda.map((t) => `${t.id}(${t.tamanho})`).join(', ')}`);
  }
  if (ok) log.ok(null, `${tarefas.length} pacote(s) válidos`);
  return ok;
}
