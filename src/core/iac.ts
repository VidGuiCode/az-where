import { readFile } from "node:fs/promises";
import { ValidationError } from "./errors.js";
import { RESOURCE_ALIASES } from "./resources.js";
import { normalizeSku } from "./sku.js";

/**
 * Lightweight IaC file parsing for `azw verify` — extract statically-known
 * `location + size` pairs from Terraform (.tf) and Bicep (.bicep) files so
 * each pair can run through the same deployability engine as `azw check vm`,
 * plus generic `type + location` pairs (since 0.4.8) that run through the
 * provider-catalog availability engine of `azw check resource`.
 *
 * This is deliberately NOT a language toolchain:
 * - Only literal string/number values are resolved. Anything dynamic
 *   (`var.location`, `"${var.size}"`, `resourceGroup().location`, a bare
 *   identifier reference) is reported as skipped with the raw expression
 *   echoed — values are never guessed.
 * - No syntax validation, no module/source following, no variable
 *   evaluation. The scanner stays quiet about constructs it does not
 *   understand instead of failing on them.
 * - Only mapped resource types are extracted: VMs and scale sets since
 *   0.4.7, the generic types in IAC_GENERIC_RESOURCE_TYPES since 0.4.8.
 *   Every other resource type is ignored without claims about it.
 *
 * Line counting survives comment/heredoc stripping (stripped lines are
 * blanked in place), so every pair and skip points at the line of its
 * `resource` declaration.
 */

export type IacFormat = "terraform" | "bicep";

/** Why a VM resource could not be turned into a checkable pair. */
export type IacSkipReason =
  | "dynamic-location"
  | "dynamic-sku"
  | "unknown-region"; // produced at region-match time, not by the parser

/** Terraform resource types → how the VM size is spelled. 0.4.7 scope. */
export const TERRAFORM_VM_RESOURCES: Record<string, "vm" | "vmss"> = {
  azurerm_linux_virtual_machine: "vm",
  azurerm_windows_virtual_machine: "vm",
  azurerm_virtual_machine: "vm", // legacy type; size attribute is `vm_size`
  azurerm_linux_virtual_machine_scale_set: "vmss",
  azurerm_windows_virtual_machine_scale_set: "vmss",
  azurerm_orchestrated_virtual_machine_scale_set: "vmss",
};

/** Bicep resource types (API version stripped) → how the size is spelled. */
export const BICEP_VM_RESOURCES: Record<string, "vm" | "vmss"> = {
  "Microsoft.Compute/virtualMachines": "vm",
  "Microsoft.Compute/virtualMachineScaleSets": "vmss",
};

/** Terraform resource types → the Azure resource type they deploy. */
const TERRAFORM_GENERIC_RESOURCES: Record<string, string> = {
  azurerm_storage_account: "Microsoft.Storage/storageAccounts",
  azurerm_key_vault: "Microsoft.KeyVault/vaults",
  // Sites covers web apps and function apps — all deploy Microsoft.Web/sites.
  azurerm_linux_web_app: "Microsoft.Web/sites",
  azurerm_windows_web_app: "Microsoft.Web/sites",
  azurerm_app_service: "Microsoft.Web/sites",
  azurerm_linux_function_app: "Microsoft.Web/sites",
  azurerm_windows_function_app: "Microsoft.Web/sites",
  azurerm_function_app: "Microsoft.Web/sites",
  azurerm_service_plan: "Microsoft.Web/serverfarms",
  azurerm_kubernetes_cluster: "Microsoft.ContainerService/managedClusters",
  azurerm_postgresql_flexible_server: "Microsoft.DBforPostgreSQL/flexibleServers",
};

/**
 * IaC resource type as written — Terraform `azurerm_*` or Bicep `Microsoft.*`
 * — → the Azure resource type `verify` checks through the ARM provider
 * catalog (availability, never deployability). Bicep writes ARM types
 * directly, so its entries are identity mappings over the RESOURCE_ALIASES
 * targets; Terraform names are listed explicitly. Types not in this table
 * are ignored. Since 0.4.8.
 */
export const IAC_GENERIC_RESOURCE_TYPES: Record<string, string> = {
  ...TERRAFORM_GENERIC_RESOURCES,
  ...Object.fromEntries(Object.values(RESOURCE_ALIASES).map((t) => [t, t])),
};

/** A statically-resolvable `location + size` pair found in a file. */
export interface IacVmPair {
  file: string;
  /** 1-based line of the `resource` declaration. */
  line: number;
  format: IacFormat;
  resourceType: string;
  resourceName: string;
  /** Normalized SKU name (Standard_B1s). */
  sku: string;
  /** The location exactly as written, e.g. `westeurope` or `West Europe`. */
  locationLiteral: string;
  /**
   * Literal instance count (scale-set `capacity`); null when dynamic or
   * absent. Single VMs are exactly 1. Scanning treats null as 1.
   */
  capacity: number | null;
}

/** A VM resource the parser found but could not check. */
export interface IacSkippedResource {
  file: string;
  line: number;
  format: IacFormat;
  resourceType: string;
  resourceName: string;
  reason: IacSkipReason;
  /** The raw expression (or literal) that caused the skip. */
  detail: string;
}

/** A statically-resolvable generic `type + location` pair. Since 0.4.8. */
export interface IacResourcePair {
  file: string;
  /** 1-based line of the `resource` declaration. */
  line: number;
  format: IacFormat;
  /** The resource type as written (`azurerm_storage_account` / `Microsoft.Storage/storageAccounts`). */
  resourceType: string;
  /** The Azure resource type the pair is checked against. */
  armType: string;
  resourceName: string;
  /** The location exactly as written, e.g. `westeurope` or `West Europe`. */
  locationLiteral: string;
}

export interface IacFileParseResult {
  file: string;
  format: IacFormat;
  pairs: IacVmPair[];
  /** Generic resource pairs found. Since 0.4.8. */
  resourcePairs: IacResourcePair[];
  skipped: IacSkippedResource[];
  /** Generic resource skips, kept separate from VM findings. Since 0.4.8. */
  resourceSkipped: IacSkippedResource[];
  /** VM + scale-set resources seen, checkable or skipped. */
  vmResourceCount: number;
  /** Generic resources seen (mapped types only), checkable or skipped. Since 0.4.8. */
  genericResourceCount: number;
}

/** Validate one CLI-given path by extension. Throws ValidationError. */
export function detectIacFormat(filePath: string): IacFormat {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".tf.json")) {
    throw new ValidationError(
      `JSON-syntax Terraform ('${filePath}') is not supported yet; verify reads plain .tf files.`,
    );
  }
  if (lower.endsWith(".tf")) return "terraform";
  if (lower.endsWith(".bicep")) return "bicep";
  throw new ValidationError(
    `Unsupported file '${filePath}': verify reads .tf (Terraform) or .bicep (Bicep) files.`,
  );
}

/** Read, validate, and parse every file. Same path twice is parsed once. */
export async function parseIacFiles(files: string[]): Promise<IacFileParseResult[]> {
  if (files.length === 0) {
    throw new ValidationError("No files given. Try: azw verify main.tf");
  }
  const seen = new Set<string>();
  const results: IacFileParseResult[] = [];
  for (const file of files) {
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const format = detectIacFormat(file);
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      throw new ValidationError(`Cannot read file '${file}'. Check the path.`);
    }
    results.push(parseIacContent(file, format, content));
  }
  return results;
}

export function parseIacContent(
  file: string,
  format: IacFormat,
  content: string,
): IacFileParseResult {
  const normalized = content.replace(/\r\n/g, "\n");
  const parsed =
    format === "terraform" ? parseTerraform(normalized) : parseBicep(normalized);
  return {
    file,
    format,
    pairs: parsed.pairs.map((p) => ({ ...p, file })),
    resourcePairs: parsed.resourcePairs.map((p) => ({ ...p, file })),
    skipped: parsed.skipped.map((s) => ({ ...s, file })),
    resourceSkipped: parsed.resourceSkipped.map((s) => ({ ...s, file })),
    vmResourceCount: parsed.vmResourceCount,
    genericResourceCount: parsed.genericResourceCount,
  };
}

/* ── Shared attribute findings ─────────────────────────────────────────── */

interface AttrFinding {
  /** Literal string value when statically resolvable. */
  literal: string | null;
  /** Raw expression as written (after trim); null when the attribute is absent. */
  raw: string | null;
}

const ATTR_MISSING: AttrFinding = { literal: null, raw: null };

/**
 * A value is checkable only when it is a plain quoted literal without
 * interpolation. Everything else — variables, references, function calls,
 * `"${…}"` — is dynamic and skipped rather than guessed.
 */
function classifyValue(raw: string): AttrFinding {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(['"])(.*)\1$/);
  if (m && !m[2].includes("${")) return { literal: m[2].trim(), raw: trimmed };
  return { literal: null, raw: trimmed };
}

/** Literal non-negative integer, e.g. a scale-set capacity; else null. */
function capacityLiteral(raw: string): number | null {
  const t = raw.trim();
  return /^\d+$/.test(t) ? Number.parseInt(t, 10) : null;
}

function findAttr(bodyLines: string[], re: RegExp): AttrFinding {
  for (const line of bodyLines) {
    const m = line.match(re);
    if (m) return classifyValue(m[1]);
  }
  return ATTR_MISSING;
}

function classifyVmResource(
  meta: {
    file: string;
    line: number;
    format: IacFormat;
    resourceType: string;
    resourceName: string;
  },
  location: AttrFinding,
  sku: AttrFinding,
  capacity: number | null,
): { pair: IacVmPair | null; skip: IacSkippedResource | null } {
  if (location.literal === null) {
    return {
      pair: null,
      skip: {
        ...meta,
        reason: "dynamic-location",
        detail: location.raw ?? "no location attribute found",
      },
    };
  }
  if (sku.literal === null) {
    return {
      pair: null,
      skip: {
        ...meta,
        reason: "dynamic-sku",
        detail: sku.raw ?? "no size/sku name attribute found",
      },
    };
  }
  return {
    pair: {
      ...meta,
      sku: normalizeSku(sku.literal),
      locationLiteral: location.literal,
      capacity,
    },
    skip: null,
  };
}

/**
 * Same rule as classifyVmResource, minus the sku: a generic resource is
 * checkable when its location is a plain literal. Dynamic locations become
 * `dynamic-location` skips echoing the raw expression. Since 0.4.8.
 */
function classifyGenericResource(
  meta: {
    file: string;
    line: number;
    format: IacFormat;
    resourceType: string;
    armType: string;
    resourceName: string;
  },
  location: AttrFinding,
): { pair: IacResourcePair | null; skip: IacSkippedResource | null } {
  if (location.literal === null) {
    return {
      pair: null,
      skip: {
        file: meta.file,
        line: meta.line,
        format: meta.format,
        resourceType: meta.resourceType,
        resourceName: meta.resourceName,
        reason: "dynamic-location",
        detail: location.raw ?? "no location attribute found",
      },
    };
  }
  return {
    pair: { ...meta, locationLiteral: location.literal },
    skip: null,
  };
}

/* ── Delimited-block extraction (quote-aware brace matching) ───────────── */

interface BlockSpan {
  /** Lines between the delimiters; first/last may be partial. */
  bodyLines: string[];
  /** Index of the line holding the closing delimiter. */
  endLine: number;
}

const CLOSER_OF: Record<string, string> = { "{": "}", "[": "]" };

/** Skip a quoted span starting at `start`; returns the index after its quote. */
function skipQuoted(line: string, start: number): number {
  const quote = line[start];
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return i; // unterminated on this line — strings never span lines here
}

/**
 * From (startLine, startCol), find the first opener char, then walk to its
 * matching closer, skipping quoted spans. Only the closers matching
 * `openers` are counted, so HCL lists (`[...]`) can't end a `{...}` block.
 * An unterminated block yields the rest of the file, best-effort.
 */
function extractDelimited(
  lines: string[],
  startLine: number,
  startCol: number,
  openers: string,
  quoteChars: string,
): BlockSpan | null {
  const closerSet = new Set([...openers].map((ch) => CLOSER_OF[ch]));

  let li = startLine;
  let ci = startCol;
  let openerCol = -1;
  while (li < lines.length && openerCol < 0) {
    const line = lines[li];
    while (ci < line.length) {
      const ch = line[ci];
      if (quoteChars.includes(ch)) {
        ci = skipQuoted(line, ci);
        continue;
      }
      if (openers.includes(ch)) {
        openerCol = ci;
        break;
      }
      ci++;
    }
    if (openerCol < 0) {
      li++;
      ci = 0;
    }
  }
  if (openerCol < 0) return null;

  let depth = 1;
  const bodyLines: string[] = [];
  let partial = "";
  let done = false;

  let col = openerCol + 1;
  let line = li;
  walk: while (line < lines.length) {
    const text = lines[line];
    while (col < text.length) {
      const ch = text[col];
      if (quoteChars.includes(ch)) {
        const end = skipQuoted(text, col);
        partial += text.slice(col, end);
        col = end;
        continue;
      }
      if (openers.includes(ch)) {
        depth++;
      } else if (closerSet.has(ch)) {
        depth--;
        if (depth === 0) {
          done = true;
          break walk;
        }
      }
      partial += ch;
      col++;
    }
    bodyLines.push(partial);
    partial = "";
    line++;
    col = 0;
  }

  if (partial.length > 0) bodyLines.push(partial);
  return { bodyLines, endLine: done ? line : lines.length - 1 };
}

/** Find a nested sub-block (`sku { … }` / `sku: { … }`) and return its body. */
function findSubBlock(
  bodyLines: string[],
  headerRe: RegExp,
  quoteChars: string,
): string[] | null {
  for (let i = 0; i < bodyLines.length; i++) {
    const m = bodyLines[i].match(headerRe);
    if (!m || m.index === undefined) continue;
    // headerRe ends with `\{`, so the brace is the last char of the match.
    const span = extractDelimited(bodyLines, i, m.index + m[0].length - 1, "{", quoteChars);
    if (span) return span.bodyLines;
  }
  return null;
}

/* ── Terraform (.tf) ───────────────────────────────────────────────────── */

function parseTerraform(content: string): Omit<IacFileParseResult, "file" | "format"> {
  const lines = stripTerraformNoise(content);
  const pairs: IacVmPair[] = [];
  const resourcePairs: IacResourcePair[] = [];
  const skipped: IacSkippedResource[] = [];
  const resourceSkipped: IacSkippedResource[] = [];
  let vmResourceCount = 0;
  let genericResourceCount = 0;
  let i = 0;

  while (i < lines.length) {
    const lead = lines[i].length - lines[i].trimStart().length;
    const header = lines[i].slice(lead).match(/^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/);
    if (!header) {
      i++;
      continue;
    }
    const resourceType = header[1];
    const resourceName = header[2];
    const kind = TERRAFORM_VM_RESOURCES[resourceType];
    const armType = IAC_GENERIC_RESOURCE_TYPES[resourceType];

    // The block body starts at the header's opening brace (last match char).
    const span = extractDelimited(lines, i, lead + header[0].length - 1, "{", '"');
    const bodyLines = span?.bodyLines ?? [];

    if (kind) {
      vmResourceCount++;
      const location = findAttr(bodyLines, /^\s*location\s*=\s*(.+?)\s*$/);
      let sku: AttrFinding;
      let capacity: number | null;
      if (kind === "vmss") {
        const skuBlock = findSubBlock(bodyLines, /^\s*sku\s*\{/, '"');
        sku = skuBlock ? findAttr(skuBlock, /^\s*name\s*=\s*(.+?)\s*$/) : ATTR_MISSING;
        const cap = skuBlock ? findAttr(skuBlock, /^\s*capacity\s*=\s*(.+?)\s*$/) : ATTR_MISSING;
        capacity = cap.raw !== null ? capacityLiteral(cap.raw) : null;
      } else {
        sku = findAttr(
          bodyLines,
          resourceType === "azurerm_virtual_machine"
            ? /^\s*vm_size\s*=\s*(.+?)\s*$/
            : /^\s*size\s*=\s*(.+?)\s*$/,
        );
        capacity = 1;
      }
      const { pair, skip } = classifyVmResource(
        { file: "", line: i + 1, format: "terraform", resourceType, resourceName },
        location,
        sku,
        capacity,
      );
      if (pair) pairs.push(pair);
      if (skip) skipped.push(skip);
    } else if (armType) {
      genericResourceCount++;
      const location = findAttr(bodyLines, /^\s*location\s*=\s*(.+?)\s*$/);
      const { pair, skip } = classifyGenericResource(
        { file: "", line: i + 1, format: "terraform", resourceType, armType, resourceName },
        location,
      );
      if (pair) resourcePairs.push(pair);
      if (skip) resourceSkipped.push(skip);
    }

    // Advance past the whole block either way so nothing inside can
    // double-match as another resource header.
    i = span ? span.endLine + 1 : i + 1;
  }

  return {
    pairs,
    resourcePairs,
    skipped,
    resourceSkipped,
    vmResourceCount,
    genericResourceCount,
  };
}

/**
 * Blank out line, block, and `#` comments plus `<<EOT` heredocs line-by-line,
 * preserving line count and quoted strings (a `#` inside a string is data).
 */
function stripTerraformNoise(content: string): string[] {
  const lines = content.split("\n");
  const out = new Array<string>(lines.length).fill("");
  let inBlockComment = false;
  let heredocTag: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) {
        continue; // line stays blank
      }
      inBlockComment = false;
      line = line.slice(end + 2);
    }
    if (heredocTag !== null) {
      if (line.trim() === heredocTag) {
        heredocTag = null; // terminator line is blanked too
      }
      continue;
    }

    let result = "";
    let j = 0;
    let inString = false;
    while (j < line.length) {
      const ch = line[j];
      if (inString) {
        result += ch;
        if (ch === "\\" && j + 1 < line.length) {
          result += line[j + 1];
          j += 2;
          continue;
        }
        if (ch === '"') inString = false;
        j++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        result += ch;
        j++;
        continue;
      }
      if (ch === "#" || (ch === "/" && line[j + 1] === "/")) break;
      if (ch === "/" && line[j + 1] === "*") {
        inBlockComment = true;
        break;
      }
      if (ch === "<" && line[j + 1] === "<") {
        const m = line.slice(j).match(/^<<-?([A-Za-z0-9_]+)/);
        if (m) {
          heredocTag = m[1];
          break;
        }
        result += "<<";
        j += 2;
        continue;
      }
      result += ch;
      j++;
    }
    out[i] = result;
  }
  return out;
}

/* ── Bicep (.bicep) ────────────────────────────────────────────────────── */

function parseBicep(content: string): Omit<IacFileParseResult, "file" | "format"> {
  const lines = stripBicepNoise(content);
  const pairs: IacVmPair[] = [];
  const resourcePairs: IacResourcePair[] = [];
  const skipped: IacSkippedResource[] = [];
  const resourceSkipped: IacSkippedResource[] = [];
  let vmResourceCount = 0;
  let genericResourceCount = 0;
  let i = 0;

  while (i < lines.length) {
    const lead = lines[i].length - lines[i].trimStart().length;
    const header = lines[i]
      .slice(lead)
      .match(/^resource\s+([A-Za-z_]\w*)\s+'([^']+)'\s*(existing)?\s*=/);
    if (!header) {
      i++;
      continue;
    }
    // `existing` resources are references, not deployments — nothing to verify.
    if (header[3] === undefined) {
      const symbolicName = header[1];
      const bareType = header[2].split("@")[0];
      const kind = BICEP_VM_RESOURCES[bareType];
      const armType = IAC_GENERIC_RESOURCE_TYPES[bareType];

      // The value starts at the first `{` or `[` after the `=`.
      const span = extractDelimited(lines, i, lead + header[0].length, "{[", "'\"");
      const bodyLines = span?.bodyLines ?? [];

      if (kind) {
        vmResourceCount++;
        const location = findAttr(bodyLines, /^\s*location\s*:\s*(.+?)\s*$/);
        let sku: AttrFinding;
        let capacity: number | null;
        if (kind === "vmss") {
          const skuBlock = findSubBlock(bodyLines, /^\s*sku\s*:\s*\{/, "'\"");
          sku = skuBlock ? findAttr(skuBlock, /^\s*name\s*:\s*(.+?)\s*$/) : ATTR_MISSING;
          const cap = skuBlock ? findAttr(skuBlock, /^\s*capacity\s*:\s*(.+?)\s*$/) : ATTR_MISSING;
          capacity = cap.raw !== null ? capacityLiteral(cap.raw) : null;
        } else {
          sku = findAttr(bodyLines, /^\s*vmSize\s*:\s*(.+?)\s*$/);
          capacity = 1;
        }
        const { pair, skip } = classifyVmResource(
          { file: "", line: i + 1, format: "bicep", resourceType: bareType, resourceName: symbolicName },
          location,
          sku,
          capacity,
        );
        if (pair) pairs.push(pair);
        if (skip) skipped.push(skip);
      } else if (armType) {
        genericResourceCount++;
        const location = findAttr(bodyLines, /^\s*location\s*:\s*(.+?)\s*$/);
        const { pair, skip } = classifyGenericResource(
          { file: "", line: i + 1, format: "bicep", resourceType: bareType, armType, resourceName: symbolicName },
          location,
        );
        if (pair) resourcePairs.push(pair);
        if (skip) resourceSkipped.push(skip);
      }

      i = span ? span.endLine + 1 : i + 1;
    } else {
      i++;
    }
  }

  return {
    pairs,
    resourcePairs,
    skipped,
    resourceSkipped,
    vmResourceCount,
    genericResourceCount,
  };
}

/**
 * Blank out line and block comments plus `'''` multi-line strings
 * line-by-line, preserving line count and quoted strings.
 */
function stripBicepNoise(content: string): string[] {
  const lines = content.split("\n");
  const out = new Array<string>(lines.length).fill("");
  let inBlockComment = false;
  let inTriple = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (inTriple) {
      const end = line.indexOf("'''");
      if (end === -1) {
        continue;
      }
      inTriple = false;
      line = line.slice(end + 3);
    }
    if (inBlockComment) {
      const end = line.indexOf("*/");
      if (end === -1) {
        continue;
      }
      inBlockComment = false;
      line = line.slice(end + 2);
    }

    let result = "";
    let j = 0;
    let quote: string | null = null;
    while (j < line.length) {
      const ch = line[j];
      if (quote !== null) {
        result += ch;
        if (ch === "\\" && j + 1 < line.length) {
          result += line[j + 1];
          j += 2;
          continue;
        }
        if (ch === quote) quote = null;
        j++;
        continue;
      }
      if (ch === "'" && line.slice(j, j + 3) === "'''") {
        inTriple = true;
        break;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        result += ch;
        j++;
        continue;
      }
      if (ch === "/" && line[j + 1] === "/") break;
      if (ch === "/" && line[j + 1] === "*") {
        inBlockComment = true;
        break;
      }
      result += ch;
      j++;
    }
    out[i] = result;
  }
  return out;
}
