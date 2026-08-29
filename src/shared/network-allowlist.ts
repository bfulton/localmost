/**
 * Network allowlists for sandbox policies.
 * Used by both the main process proxy and CLI test command.
 */

/**
 * Hosts the Actions runner daemon itself requires.
 *
 * runner-manager.ts launches the runner binary with HTTP_PROXY pointed at this
 * proxy, so the runner's own control-plane traffic passes through it. If these
 * hosts are blocked the runner cannot register or poll for jobs and no policy
 * level is usable. They are therefore allowed at every policy level.
 *
 * Note this necessarily grants jobs access to the same hosts: a single proxy
 * cannot distinguish the runner's traffic from a step's traffic.
 */
export const RUNNER_INFRASTRUCTURE_ALLOWLIST = [
  // Local broker proxy (for multi-target support)
  'localhost',
  '127.0.0.1',

  // Runner registration
  'github.com',
  'api.github.com',

  // Job dispatch, tokens, and results reporting
  '*.actions.githubusercontent.com',

  // Azure blob storage for log and artifact upload
  '*.blob.core.windows.net',
];

/**
 * Network allowlist for "moderate" policy level.
 * Includes GitHub Actions infrastructure and common package registries.
 */
export const MODERATE_NETWORK_ALLOWLIST = [
  ...RUNNER_INFRASTRUCTURE_ALLOWLIST,

  // GitHub API and services
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'github-registry-files.githubusercontent.com',
  'ghcr.io',
  'pkg.github.com',

  // Node.js (for actions/setup-node)
  'nodejs.org',

  // GitHub Actions specific
  'pipelines.actions.githubusercontent.com',
  'results-receiver.actions.githubusercontent.com',
  'vstoken.actions.githubusercontent.com',
  'token.actions.githubusercontent.com',
  'artifactcache.actions.githubusercontent.com',

  // Common package registries
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'rubygems.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io', // cargo 1.70+ sparse index, fetched before any crate
  'static.rust-lang.org', // rustup toolchain downloads
  'api.nuget.org',

  // Apple/Xcode
  '*.apple.com',
  'cdn.cocoapods.org',
  'trunk.cocoapods.org',

  // Common CDNs
  '*.cloudfront.net',
  '*.fastly.net',
];

/**
 * Network allowlist for "strict" policy level.
 *
 * Empty on purpose: beyond RUNNER_INFRASTRUCTURE_ALLOWLIST, which every level
 * grants, all hosts must be declared in .localmostrc.
 */
export const STRICT_NETWORK_ALLOWLIST: string[] = [];
