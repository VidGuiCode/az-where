import { armList } from "./arm.js";

const POLICY_ASSIGNMENTS_PATH =
  "/providers/Microsoft.Authorization/policyAssignments?api-version=2023-04-01&$filter=atScope()";

export interface PolicyParameter {
  value?: unknown;
}

export interface PolicyAssignment {
  id?: string;
  name?: string;
  properties?: {
    displayName?: string;
    enforcementMode?: string;
    parameters?: Record<string, PolicyParameter | undefined>;
  };
}

export interface PolicyAssignmentSummary {
  name: string;
  displayName: string;
}

export interface PolicySummary {
  checked: boolean;
  restricted: boolean;
  allowedLocations: string[] | null;
  assignments: PolicyAssignmentSummary[];
  error: string | null;
}

export interface PolicyCheck {
  summary: PolicySummary;
  isAllowed(region: string): boolean;
  reason(region: string): string | null;
}

export interface LoadPolicyOptions {
  enabled: boolean;
  required: boolean;
}

export interface LoadedPolicy {
  check: PolicyCheck | undefined;
  summary: PolicySummary;
}

export class PolicyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyReadError";
  }
}

export const POLICY_DISABLED: PolicySummary = {
  checked: false,
  restricted: false,
  allowedLocations: null,
  assignments: [],
  error: null,
};

export function disabledPolicyCheck(): PolicyCheck {
  return buildPolicyCheck(POLICY_DISABLED);
}

export async function readPolicyCheck(): Promise<PolicyCheck> {
  try {
    const assignments = await armList<PolicyAssignment>(POLICY_ASSIGNMENTS_PATH, {
      cache: false,
      timeoutMs: 10_000,
    });
    return buildPolicyCheck(parseAllowedLocationPolicy(assignments));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolicyReadError(`Could not read Azure Policy assignments: ${msg}`);
  }
}

export async function loadPolicyCheck(opts: LoadPolicyOptions): Promise<LoadedPolicy> {
  if (!opts.enabled) return { check: undefined, summary: POLICY_DISABLED };
  try {
    const check = await readPolicyCheck();
    return { check, summary: check.summary };
  } catch (err) {
    if (opts.required) throw err;
    return { check: undefined, summary: failedPolicySummary(err) };
  }
}

export function failedPolicySummary(error: unknown): PolicySummary {
  const msg = error instanceof Error ? error.message : String(error);
  return {
    checked: false,
    restricted: false,
    allowedLocations: null,
    assignments: [],
    error: msg,
  };
}

export function parseAllowedLocationPolicy(assignments: PolicyAssignment[]): PolicySummary {
  let allowed: Set<string> | null = null;
  const matched: PolicyAssignmentSummary[] = [];

  for (const assignment of assignments) {
    const props = assignment.properties ?? {};
    if (props.enforcementMode?.toLowerCase() === "donotenforce") continue;
    if (hasExplicitNonDenyEffect(props.parameters ?? {})) continue;

    const locations = allowedLocationsFromParameters(props.parameters ?? {});
    if (!locations) continue;

    const normalized = new Set(locations.map(normalizeRegion));
    allowed = allowed ? intersect(allowed, normalized) : normalized;
    matched.push({
      name: assignment.name ?? lastPathSegment(assignment.id ?? "") ?? "",
      displayName: props.displayName ?? assignment.name ?? "",
    });
  }

  const allowedLocations = allowed ? [...allowed].sort() : null;
  return {
    checked: true,
    restricted: Boolean(allowedLocations),
    allowedLocations,
    assignments: matched,
    error: null,
  };
}

export function buildPolicyCheck(summary: PolicySummary): PolicyCheck {
  const allowed = summary.allowedLocations ? new Set(summary.allowedLocations.map(normalizeRegion)) : null;
  return {
    summary,
    isAllowed(region: string): boolean {
      if (!allowed) return true;
      return allowed.has(normalizeRegion(region));
    },
    reason(region: string): string | null {
      if (!allowed || allowed.has(normalizeRegion(region))) return null;
      const source =
        summary.assignments.length > 0
          ? ` by policy ${summary.assignments.map((a) => a.name).join(", ")}`
          : "";
      return `${region} is not in the Azure Policy allowed-location list${source}.`;
    },
  };
}

function allowedLocationsFromParameters(
  parameters: Record<string, PolicyParameter | undefined>,
): string[] | null {
  const raw =
    parameters.listOfAllowedLocations?.value ?? parameters.allowedLocations?.value ?? null;
  if (!Array.isArray(raw)) return null;
  const locations = raw.filter((v): v is string => typeof v === "string").map(normalizeRegion);
  return locations.length > 0 ? [...new Set(locations)] : null;
}

function hasExplicitNonDenyEffect(parameters: Record<string, PolicyParameter | undefined>): boolean {
  const raw = parameters.effect?.value;
  if (typeof raw !== "string") return false;
  const effect = raw.trim().toLowerCase();
  return effect.length > 0 && effect !== "deny";
}

function normalizeRegion(region: string): string {
  return region.trim().toLowerCase();
}

function intersect(a: Set<string>, b: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const value of a) {
    if (b.has(value)) out.add(value);
  }
  return out;
}

function lastPathSegment(id: string): string | null {
  const part = id.split("/").filter(Boolean).at(-1);
  return part || null;
}
