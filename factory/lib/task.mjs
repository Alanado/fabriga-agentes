// Leitura dos pacotes de tarefa (.factory/tasks/<id>.md).
import fs from 'node:fs';
import path from 'node:path';
import { falhar, existe } from './util.mjs';

function valorYaml(bruto) {
  let v = bruto.replace(/\s+#.*$/, '').trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  v = v.replace(/^["']|["']$/g, '');
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

const normalizarSecao = (t) =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, '')
    .trim();

/** Item de lista: tira "- ", "- [ ] ", crases e anotações como " (novo)". */
function itemDeLista(linha) {
  return linha
    .replace(/^\s*[-*]\s+(\[[ xX]\]\s+)?/, '')
    .replace(/`/g, '')
    .replace(/\s+\(.*\)\s*$/, '')
    .trim();
}

export function lerTarefa(dirTasks, id) {
  const arquivo = path.join(dirTasks, `${id}.md`);
  if (!existe(arquivo)) falhar(`Pacote de tarefa não encontrado: ${arquivo}`);
  return parseTarefa(fs.readFileSync(arquivo, 'utf8'), arquivo);
}

export function parseTarefa(texto, arquivo = '(texto)') {
  const m = texto.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) falhar(`${arquivo}: faltou o cabeçalho entre linhas "---".`);
  const meta = {};
  for (const linha of m[1].split('\n')) {
    const kv = linha.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]] = valorYaml(kv[2]);
  }
  const secoes = {};
  let atual = null;
  for (const linha of m[2].split('\n')) {
    const h = linha.match(/^##\s+(.+)$/);
    if (h) {
      atual = normalizarSecao(h[1]);
      secoes[atual] = [];
    } else if (atual) secoes[atual].push(linha);
  }
  const lista = (nome) =>
    (secoes[nome] || []).filter((l) => /^\s*[-*]\s+/.test(l)).map(itemDeLista).filter(Boolean);

  const proibidosBrutos = lista('proibido alterar');
  const t = {
    arquivo,
    texto,
    id: String(meta.id || ''),
    titulo: String(meta.titulo || meta.title || ''),
    onda: Number(meta.onda ?? meta.wave ?? 1),
    dependeDe: Array.isArray(meta.depende_de) ? meta.depende_de : meta.depende_de ? [String(meta.depende_de)] : [],
    tamanho: String(meta.tamanho || 'M').toUpperCase(),
    slot: meta.slot ? Number(meta.slot) : null,
    tentativasMax: meta.tentativas_max ? Number(meta.tentativas_max) : null,
    contexto: lista('contexto'),
    permitidos: lista('permitido alterar'),
    // linhas de texto livre como "qualquer arquivo fora de ..." não são globs
    proibidos: proibidosBrutos.filter((p) => !/\s/.test(p)),
    aceite: lista('testes de aceite'),
    criterios: (secoes['criterios de aceite'] || [])
      .map((l) => l.match(/\b(CA\d+)\b/))
      .filter(Boolean)
      .map((x) => x[1]),
  };
  if (!t.id) falhar(`${arquivo}: falta "id" no cabeçalho.`);
  if (!['P', 'M', 'G'].includes(t.tamanho)) falhar(`${arquivo}: "tamanho" deve ser P, M ou G.`);
  if (t.permitidos.length === 0) falhar(`${arquivo}: a seção "Permitido alterar" está vazia.`);
  return t;
}

export function listarTarefas(dirTasks) {
  if (!existe(dirTasks)) return [];
  return fs
    .readdirSync(dirTasks)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .map((f) => lerTarefa(dirTasks, f.slice(0, -3)))
    .sort((a, b) => a.onda - b.onda || a.id.localeCompare(b.id));
}
