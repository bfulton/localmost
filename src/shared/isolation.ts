/**
 * Isolation types: how a job is kept from the rest of the Mac, and which one
 * a job gets.
 *
 * A repository's .localmostrc lists, in order, the types it accepts
 * (`isolation:`); this Mac allows a set of them (Settings > Isolation, the
 * `isolation.allowed` section of config.yaml); this build can run some of
 * them. A job gets the first type in its repository's list that this Mac both
 * allows and can run, and is refused when there is none - never run under a
 * type its repository did not list. The repository's order decides among the
 * types that pass; the host's allowed set decides which pass at all, so a
 * repository's order can never reach a type the owner has not allowed. See
 * docs/roadmap/localmostrc.md (Isolation) and SECURITY.md.
 *
 * Shared by the main process (admission, settings, the store), the CLI's
 * policy grammar and the renderer's Settings page.
 */

/** Every isolation type the grammar knows, built or not. */
export const ISOLATION_TYPES = ['seatbelt', 'service-account', 'macos-vm'] as const;

export type IsolationType = (typeof ISOLATION_TYPES)[number];

/**
 * What `isolation:` may say: `any`, one type (shorthand for a one-item list),
 * or a list of types in the order to try.
 */
export type IsolationDeclaration = 'any' | IsolationType | IsolationType[];

/**
 * What `any`, and an absent `isolation:`, mean: every type, strongest
 * separation first, so a job gets the strongest this Mac allows and can run.
 */
export const ANY_ISOLATION: readonly IsolationType[] = Object.freeze(['macos-vm', 'service-account', 'seatbelt'] as const);

export const isIsolationType = (value: unknown): value is IsolationType =>
  typeof value === 'string' && (ISOLATION_TYPES as readonly string[]).includes(value);

/** A declaration as the ordered list it stands for. */
export function isolationList(declaration: IsolationDeclaration | undefined): IsolationType[] {
  if (declaration === undefined || declaration === 'any') return [...ANY_ISOLATION];
  return typeof declaration === 'string' ? [declaration] : [...declaration];
}

/**
 * Why `value` is not an `isolation:` the grammar accepts, one message per
 * problem, or none. A type this build cannot run is accepted: the list says
 * what the repository accepts, and what cannot run here is filtered out when
 * a job is admitted.
 */
export function isolationDeclarationProblems(value: unknown, path: string): string[] {
  if (value === 'any' || isIsolationType(value)) return [];
  if (typeof value === 'string') {
    return [`${path}: ${JSON.stringify(value)} is not an isolation type. Accepted: ${ISOLATION_TYPES.join(', ')}, or any.`];
  }
  if (!Array.isArray(value)) {
    return [`${path} must be any, an isolation type, or a list of them in the order to try`];
  }
  if (value.length === 0) return [`${path} must list at least one isolation type, or be any`];
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, i) => {
    if (typeof entry !== 'string') {
      problems.push(`${path}[${i}] must be an isolation type`);
    } else if (entry === 'any') {
      problems.push(`${path}[${i}]: "any" stands alone: write isolation: any, or list the types in order.`);
    } else if (!isIsolationType(entry)) {
      problems.push(`${path}[${i}]: ${JSON.stringify(entry)} is not an isolation type. Accepted: ${ISOLATION_TYPES.join(', ')}.`);
    } else if (seen.has(entry)) {
      problems.push(`${path} lists ${entry} twice`);
    } else {
      seen.add(entry);
    }
  });
  return problems;
}

/**
 * The isolation types this build can run and that are set up on this Mac.
 * Seatbelt needs no setup. The service account needs its privileged helper
 * installed, and the macOS VM its golden image; neither is in this build, so
 * today this is seatbelt alone.
 */
export function availableIsolationTypes(): IsolationType[] {
  return ['seatbelt'];
}

/** What admission decides: the type the job runs under, or why it runs under none. */
export type IsolationSelection = { type: IsolationType } | { refusal: string };

/** Types joined for a sentence: "a", "a and b", "a, b and c". */
function joinTypes(types: readonly string[]): string {
  return types.length <= 1 ? types.join('') : `${types.slice(0, -1).join(', ')} and ${types[types.length - 1]}`;
}

/**
 * The first type of `accepted` - the repository's list, in its order - that
 * is in both `allowed` (this Mac's) and `available` (this build's). None, and
 * the job is refused with what each side holds; it is never given a type the
 * repository did not list.
 */
export function selectIsolation(
  accepted: readonly IsolationType[],
  allowed: readonly IsolationType[],
  available: readonly IsolationType[]
): IsolationSelection {
  const type = accepted.find((t) => allowed.includes(t) && available.includes(t));
  if (type) return { type };
  const parts = [
    `this repository accepts ${accepted.join(', ')}`,
    `this Mac allows ${allowed.length > 0 ? allowed.join(', ') : 'none'}`,
  ];
  const unavailable = accepted.filter((t) => !available.includes(t));
  if (unavailable.length > 0) {
    parts.push(`${joinTypes(unavailable)} ${unavailable.length === 1 ? 'is' : 'are'} not available in this build`);
  }
  const notAllowed = accepted.filter((t) => available.includes(t) && !allowed.includes(t));
  if (notAllowed.length > 0) {
    parts.push(`${joinTypes(notAllowed)} ${notAllowed.length === 1 ? 'is' : 'are'} not allowed in Settings > Isolation`);
  }
  return { refusal: parts.join('; ') };
}

/**
 * Which isolation types this Mac allows a job to get: the `isolation`
 * section of config.yaml, set from the Isolation section of Settings, and
 * read from the store at each admission. It is the guard: a repository's
 * list orders the types it accepts, and only these can be chosen.
 */
export interface IsolationConfig {
  /** The types a job may get on this Mac, in no particular order: the repository's list orders them. */
  allowed: IsolationType[];
}

/**
 * Seatbelt alone in this build, the only type it can run. From the build
 * that ships the macOS VM type the default becomes the VM alone. Frozen, as
 * the job-environment defaults are.
 */
export const DEFAULT_ISOLATION_CONFIG: Readonly<{ allowed: readonly IsolationType[] }> = Object.freeze({
  allowed: Object.freeze(['seatbelt'] as IsolationType[]),
});

/**
 * The `isolation` section of config.yaml as used. `allowed` absent is the
 * default; anything but a list is taken as absent, and an unknown or
 * repeated type in it is dropped, each with a line through `log`. A type
 * this build cannot run is kept: it allows nothing until the build can, and
 * a config a later build wrote survives a launch of this one.
 */
export function resolveIsolationConfig(
  raw: Partial<Record<keyof IsolationConfig, unknown>> | undefined,
  log: (message: string) => void = () => {}
): IsolationConfig {
  const section: Record<string, unknown> = typeof raw === 'object' && raw !== null ? raw : {};
  const fallback = (): IsolationConfig => ({ allowed: [...DEFAULT_ISOLATION_CONFIG.allowed] });
  if (section.allowed === undefined) return fallback();
  if (!Array.isArray(section.allowed)) {
    log(`isolation.allowed must be a list of isolation types; using ${DEFAULT_ISOLATION_CONFIG.allowed.join(', ')}`);
    return fallback();
  }
  const allowed: IsolationType[] = [];
  for (const entry of section.allowed as unknown[]) {
    if (!isIsolationType(entry)) {
      log(`isolation.allowed: ignoring ${JSON.stringify(entry)}, which is not an isolation type`);
    } else if (allowed.includes(entry)) {
      log(`isolation.allowed: ignoring ${entry} listed twice`);
    } else {
      allowed.push(entry);
    }
  }
  return { allowed };
}

/** How each type is named and explained in Settings and in a policy's description. */
export const ISOLATION_DESCRIPTIONS: Readonly<Record<IsolationType, { label: string; description: string }>> = Object.freeze({
  seatbelt: {
    label: 'Seatbelt sandbox',
    description:
      'Each job runs as you, under a macOS sandbox profile built from its approved policy, with a home and temp ' +
      'directory of its own. Needs no setup. Shares the per-user temp directory and the window server with you.',
  },
  'service-account': {
    label: 'Service account',
    description:
      'Each job runs as a hidden _localmost user, started by a privileged helper you install once with an ' +
      "administrator's approval: its own temp directory and preferences, none of your keychain. Headless only: " +
      'no Electron, Simulator, UI tests or Safari.',
  },
  'macos-vm': {
    label: 'macOS VM',
    description:
      'Each job runs in a fresh macOS VM cloned from a golden image: full separation, its own window server ' +
      'included. At most two run at once, and each job waits for its VM to boot.',
  },
});
