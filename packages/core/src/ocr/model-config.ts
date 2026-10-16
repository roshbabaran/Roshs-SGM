/**
 * Settings that come with each PaddleOCR model. Every official model folder has
 * `inference.onnx` and `inference.yml` (saved in models/ocr as model.onnx and
 * config.yml, see README.md); the YAML holds the detector's
 * thresholds and normalisation and, for the recogniser, its input height and
 * its character dictionary. The dictionary must be the model's own: PP-OCRv6
 * extended it, so reading v6 output with the v5 list would scramble the text.
 */

export interface DetConfig {
  modelName: string;
  /** A pixel counts as text above this probability. */
  thresh: number;
  /** A box whose average probability is below this is dropped. */
  boxThresh: number;
  /** How much to grow each box, because the model draws them a little tight. */
  unclipRatio: number;
  maxCandidates: number;
  /** Per-channel normalisation, in the blue, green, red order the model was trained with. */
  mean: [number, number, number];
  std: [number, number, number];
  scale: number;
}

export interface RecConfig {
  modelName: string;
  /** Input height in pixels (48 for PP-OCRv5 and v6). */
  height: number;
  /** Narrowest input width; shorter lines are padded to it. */
  minWidth: number;
  /**
   * What each output class means: index 0 is the CTC "blank", 1..n the
   * dictionary in order, and the last a space.
   */
  characters: string[];
}

/** PaddleOCR's defaults, used when a model's YAML leaves a value out. */
const DET_DEFAULTS: Omit<DetConfig, 'modelName'> = {
  thresh: 0.3,
  boxThresh: 0.6,
  unclipRatio: 1.5,
  maxCandidates: 1000,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  scale: 1 / 255,
};

export function parseDetConfig(yamlText: string): DetConfig {
  const doc = asMap(parseYaml(yamlText));
  const post = asMap(doc.PostProcess);
  const normalize = transformOp(doc, 'NormalizeImage');
  return {
    modelName: modelName(doc),
    thresh: toNumber(post.thresh, DET_DEFAULTS.thresh),
    boxThresh: toNumber(post.box_thresh, DET_DEFAULTS.boxThresh),
    unclipRatio: toNumber(post.unclip_ratio, DET_DEFAULTS.unclipRatio),
    maxCandidates: toNumber(post.max_candidates, DET_DEFAULTS.maxCandidates),
    mean: toTriple(normalize.mean, DET_DEFAULTS.mean),
    std: toTriple(normalize.std, DET_DEFAULTS.std),
    scale: toNumber(normalize.scale, DET_DEFAULTS.scale),
  };
}

export function parseRecConfig(yamlText: string): RecConfig {
  const doc = asMap(parseYaml(yamlText));
  const shape = asList(transformOp(doc, 'RecResizeImg').image_shape).map((v) => toNumber(v, NaN));
  const dictionary = asList(asMap(doc.PostProcess).character_dict);
  if (shape.length !== 3 || shape.some((v) => !Number.isFinite(v))) {
    throw new Error('The recognition model settings have no input size (RecResizeImg.image_shape).');
  }
  if (dictionary.length === 0) {
    throw new Error('The recognition model settings have no character dictionary (PostProcess.character_dict).');
  }
  const characters = ['', ...dictionary.map((c) => (typeof c === 'string' ? c : '')), ' '];
  return { modelName: modelName(doc), height: shape[1], minWidth: shape[2], characters };
}

// --- A small YAML reader ---------------------------------------------------
//
// inference.yml is written by PyYAML in block style, so this reads only that
// subset: nested mappings and lists (including lists at the same indent as
// their key), plain, single- and double-quoted scalars, anchors and aliases.
// Every scalar stays a string (or null) so dictionary entries such as "0" or
// "~" keep their text; callers convert numbers themselves.

export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine {
  indent: number;
  text: string;
}

export function parseYaml(text: string): YamlValue {
  const lines: YamlLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    // YAML only treats spaces and tabs as blanks; entries such as U+3000 (ideographic space) are real characters.
    const trimmed = raw.replace(/[ \t]+$/, '');
    const body = trimmed.replace(/^[ \t]+/, '');
    if (!body || body.startsWith('#') || body === '---' || body === '...') continue;
    lines.push({ indent: trimmed.length - body.length, text: body });
  }
  const anchors = new Map<string, YamlValue>();
  if (lines.length === 0) return null;
  return new YamlReader(lines, anchors).node(0, lines[0].indent)[0];
}

class YamlReader {
  constructor(
    private readonly lines: YamlLine[],
    private readonly anchors: Map<string, YamlValue>,
  ) {}

  /** Reads the block that starts at line `i` with the given indent. Returns the value and the next line to read. */
  node(i: number, indent: number): [YamlValue, number] {
    return isListItem(this.lines[i].text) ? this.list(i, indent) : this.map(i, indent);
  }

  private list(i: number, indent: number): [YamlValue[], number] {
    const items: YamlValue[] = [];
    while (i < this.lines.length && this.lines[i].indent === indent && isListItem(this.lines[i].text)) {
      const rest = this.lines[i].text.slice(1).replace(/^[ \t]+/, '');
      const restIndent = indent + (this.lines[i].text.length - rest.length);
      if (!rest) {
        const [value, next] = this.child(i + 1, indent);
        items.push(value);
        i = next;
      } else if (isListItem(rest) || splitKey(rest)) {
        // "- key: value" starts a mapping (or "- - x" a list) whose first line sits after the dash.
        const lines = this.lines.slice();
        lines[i] = { indent: restIndent, text: rest };
        const reader = new YamlReader(lines, this.anchors);
        const [value, next] = reader.node(i, restIndent);
        items.push(value);
        i = next;
      } else {
        items.push(this.scalar(rest));
        i += 1;
      }
    }
    return [items, i];
  }

  private map(i: number, indent: number): [{ [key: string]: YamlValue }, number] {
    const result: { [key: string]: YamlValue } = {};
    while (i < this.lines.length && this.lines[i].indent === indent && !isListItem(this.lines[i].text)) {
      const pair = splitKey(this.lines[i].text);
      if (!pair) throw new Error(`Unexpected line in model settings: ${this.lines[i].text}`);
      const [key, rest] = pair;
      if (rest && !/^&[^ \t]+$/.test(rest)) {
        result[key] = this.scalar(rest);
        i += 1;
        continue;
      }
      const anchor = rest ? rest.slice(1) : null;
      const [value, next] = this.child(i + 1, indent, true);
      if (anchor) this.anchors.set(anchor, value);
      result[key] = value;
      i = next;
    }
    return [result, i];
  }

  /** The block under a key or a bare "-": deeper lines, or a list at the same indent as its key. */
  private child(i: number, parentIndent: number, allowSameIndentList = false): [YamlValue, number] {
    const line = this.lines[i];
    if (!line) return [null, i];
    if (line.indent > parentIndent) return this.node(i, line.indent);
    if (allowSameIndentList && line.indent === parentIndent && isListItem(line.text)) return this.list(i, line.indent);
    return [null, i];
  }

  private scalar(text: string): YamlValue {
    let value = text;
    let anchor: string | null = null;
    const anchored = /^&([^ \t]+)[ \t]+(.*)$/.exec(value);
    if (anchored) {
      anchor = anchored[1];
      value = anchored[2];
    }
    let result: YamlValue;
    if (value.startsWith('*')) result = this.anchors.get(value.slice(1)) ?? null;
    else if (value === '[]') result = [];
    else if (value === '{}') result = {};
    else result = unquote(value);
    if (anchor) this.anchors.set(anchor, result);
    return result;
  }
}

function isListItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** Splits "key: value" (or "key:"). Keys in these files are plain or quoted words. */
function splitKey(text: string): [string, string] | null {
  let key: string;
  let rest: string;
  if (text.startsWith("'") || text.startsWith('"')) {
    const end = closingQuote(text);
    if (end < 0 || text[end + 1] !== ':') return null;
    key = String(unquote(text.slice(0, end + 1)));
    rest = text.slice(end + 2);
  } else {
    const match = /^([^ \t:#][^:#]*?):(?:[ \t]+|$)/.exec(text);
    if (!match) return null;
    key = match[1];
    rest = text.slice(match[0].length);
  }
  return [key, stripComment(rest.replace(/^[ \t]+|[ \t]+$/g, ''))];
}

function closingQuote(text: string): number {
  const quote = text[0];
  for (let i = 1; i < text.length; i += 1) {
    if (quote === "'" && text[i] === "'") {
      if (text[i + 1] === "'") {
        i += 1;
        continue;
      }
      return i;
    }
    if (quote === '"') {
      if (text[i] === '\\') {
        i += 1;
        continue;
      }
      if (text[i] === '"') return i;
    }
  }
  return -1;
}

function stripComment(text: string): string {
  if (text.startsWith("'") || text.startsWith('"')) return text;
  const index = text.search(/[ \t]#/);
  return index >= 0 ? text.slice(0, index).replace(/[ \t]+$/, '') : text;
}

function unquote(text: string): string | null {
  if (text.startsWith("'")) return text.slice(1, closingQuote(text)).replace(/''/g, "'");
  if (text.startsWith('"')) return unescapeDoubleQuoted(text.slice(1, closingQuote(text)));
  const plain = stripComment(text);
  if (plain === '' || plain === '~' || plain === 'null' || plain === 'Null' || plain === 'NULL') return null;
  return plain;
}

const ESCAPES: Record<string, string> = {
  '0': '\0',
  a: '\x07',
  b: '\b',
  t: '\t',
  n: '\n',
  v: '\v',
  f: '\f',
  r: '\r',
  e: '\x1b',
  ' ': ' ',
  '"': '"',
  '/': '/',
  '\\': '\\',
  N: '\x85',
  _: '\xa0',
  L: ' ',
  P: ' ',
};

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, code: string) => {
    if (code.length > 1) return String.fromCodePoint(parseInt(code.slice(1), 16));
    return ESCAPES[code] ?? code;
  });
}

// --- Reading values out of the parsed YAML ---------------------------------

type YamlMap = { [key: string]: YamlValue };

function asMap(value: YamlValue | undefined): YamlMap {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asList(value: YamlValue | undefined): YamlValue[] {
  return Array.isArray(value) ? value : [];
}

function modelName(doc: YamlMap): string {
  const name = asMap(doc.Global).model_name ?? doc.model_name;
  return typeof name === 'string' ? name : '';
}

/** The settings of one PreProcess step, e.g. NormalizeImage. */
function transformOp(doc: YamlMap, name: string): YamlMap {
  for (const op of asList(asMap(doc.PreProcess).transform_ops)) {
    const entry = asMap(op);
    if (name in entry) return asMap(entry[name]);
  }
  return {};
}

/** Numbers as PaddleOCR writes them, including fractions such as "1./255.". */
function toNumber(value: YamlValue | undefined, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[ \t]/g, '');
  const direct = Number(text);
  if (text && Number.isFinite(direct)) return direct;
  const fraction = /^([\d.]+)\/([\d.]+)$/.exec(text);
  if (fraction) {
    const result = parseFloat(fraction[1]) / parseFloat(fraction[2]);
    if (Number.isFinite(result)) return result;
  }
  return fallback;
}

function toTriple(value: YamlValue | undefined, fallback: [number, number, number]): [number, number, number] {
  const list = asList(value).map((v) => toNumber(v, NaN));
  return list.length === 3 && list.every(Number.isFinite) ? [list[0], list[1], list[2]] : fallback;
}
