// Utilitários sem dependências: processos, arquivos, globs, log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cores = process.stdout.isTTY && !process.env.NO_COLOR;
const pinta = (c, s) => (cores ? `\x1b[${c}m${s}\x1b[0m` : s);
export const log = {
  info: (id, msg) => console.log(`${pinta('2', hora())} ${id ? pinta('36', `[${id}]`) + ' ' : ''}${msg}`),
  ok: (id, msg) => console.log(`${pinta('2', hora())} ${id ? pinta('36', `[${id}]`) + ' ' : ''}${pinta('32', '✓')} ${msg}`),
  erro: (id, msg) => console.log(`${pinta('2', hora())} ${id ? pinta('36', `[${id}]`) + ' ' : ''}${pinta('31', '✗')} ${msg}`),
  aviso: (id, msg) => console.log(`${pinta('2', hora())} ${id ? pinta('36', `[${id}]`) + ' ' : ''}${pinta('33', '!')} ${msg}`),
};
function hora() {
  return new Date().toTimeString().slice(0, 8);
}

export class FabError extends Error {}
export const falhar = (msg) => {
  throw new FabError(msg);
};

/**
 * Executa um comando sem shell. Retorna { code, stdout, stderr, timedOut }.
 * opts: cwd, env, input, timeoutMs, logFile (anexa stdout+stderr), quiet
 */
export function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const logStream = opts.logFile ? fs.createWriteStream(opts.logFile, { flags: 'a' }) : null;
    child.stdout.on('data', (d) => {
      stdout += d;
      logStream?.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      logStream?.write(d);
    });
    let timer;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGINT');
        setTimeout(() => child.kill('SIGTERM'), 10_000).unref();
      }, opts.timeoutMs);
    }
    child.on('error', (e) => {
      clearTimeout(timer);
      logStream?.end();
      resolve({ code: 127, stdout, stderr: stderr + String(e), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      logStream?.end();
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    if (opts.input != null) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Executa uma linha de comando com bash (para comandos definidos no profile). */
export function sh(linha, opts = {}) {
  return run('bash', ['-c', linha], opts);
}

/** git com erro descritivo. */
export async function git(args, cwd, { permitirFalha = false } = {}) {
  const r = await run('git', args, { cwd });
  if (r.code !== 0 && !permitirFalha) {
    falhar(`git ${args.join(' ')} falhou em ${cwd}:\n${r.stderr || r.stdout}`);
  }
  return permitirFalha ? r : r.stdout.trim();
}

export const existe = (p) => fs.existsSync(p);
export const lerTexto = (p) => fs.readFileSync(p, 'utf8');
export function lerJSON(p, padrao) {
  if (!fs.existsSync(p)) {
    if (padrao !== undefined) return padrao;
    falhar(`Arquivo não encontrado: ${p}`);
  }
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    falhar(`JSON inválido em ${p}: ${e.message}`);
  }
}
export function gravarJSON(p, dados) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(dados, null, 2) + '\n');
  fs.renameSync(tmp, p);
}
export function gravarTexto(p, texto) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, texto);
}
export const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });

/** Últimas n linhas de um texto. */
export function cauda(texto, n) {
  const linhas = String(texto).trimEnd().split('\n');
  return linhas.slice(-n).join('\n');
}

/**
 * Converte um glob (estilo gitignore simplificado) em RegExp ancorada.
 * `**` atravessa pastas, `*` fica dentro de um segmento, `?` é um caractere.
 * Um padrão terminado em `/` ou sem curinga também casa tudo abaixo dele.
 */
export function globParaRegex(glob) {
  let g = glob.trim().replace(/^\.\//, '').replace(/^\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        // "**/" casa zero ou mais pastas; "**" no fim casa tudo
        if (g[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  const semCuringa = !/[*?]/.test(g);
  return new RegExp(`^${re}${semCuringa ? '(?:/.*)?' : ''}$`);
}

export function casaAlgum(arquivo, globs) {
  return globs.some((g) => globParaRegex(g).test(arquivo));
}

/** Prefixo literal de um glob (antes do primeiro curinga), usado para detectar sobreposição. */
export function prefixoLiteral(glob) {
  const g = glob.trim().replace(/^\.\//, '').replace(/^\//, '');
  const i = g.search(/[*?]/);
  return i === -1 ? g : g.slice(0, i);
}

/** Lê um arquivo .env simples (KEY=valor). */
export function lerEnv(p) {
  const env = {};
  if (!fs.existsSync(p)) return env;
  for (const linha of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = linha.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

/** Substitui {chave} por valores. */
export function preencher(modelo, valores) {
  return String(modelo).replace(/\{(\w+)\}/g, (m, k) => (k in valores ? String(valores[k]) : m));
}

/** Mutex simples para serializar operações no repositório principal. */
export function criarMutex() {
  let fila = Promise.resolve();
  return (fn) => {
    const p = fila.then(fn, fn);
    fila = p.catch(() => {});
    return p;
  };
}
