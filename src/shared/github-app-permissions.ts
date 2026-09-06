/**
 * The permissions the localmost GitHub App requests.
 *
 * The App's real permissions live in its settings on github.com, which this
 * repository has no copy of. Three documents restate them for users - the
 * description text pasted into the App settings (`docs/github-app-description.md`),
 * the README table, and the SECURITY.md list - and nothing else keeps those in
 * step with each other.
 *
 * This list is the one place to edit when the App's permissions change:
 * `github-app-permissions.test.ts` checks all three documents against it. It is
 * documentation, not configuration - no app code reads it, and changing it does
 * not change what the App requests. Update the App settings on github.com too.
 */

export interface GitHubAppPermission {
  /** Name as GitHub's settings UI and our docs spell it. */
  name: string;
  /** Whether the permission is granted over an org or its repositories. */
  scope: 'repo' | 'org';
  level: 'read' | 'read-write';
  /** How the App description text names the resource. */
  describedAs: string;
  /** Why localmost needs it, for the README and SECURITY.md. */
  purpose: string;
}

export const GITHUB_APP_PERMISSIONS: GitHubAppPermission[] = [
  {
    name: 'Administration',
    scope: 'repo',
    level: 'read-write',
    describedAs: 'administration',
    purpose: 'Register and remove self-hosted runners on repositories',
  },
  {
    name: 'Actions',
    scope: 'repo',
    level: 'read-write',
    describedAs: 'actions',
    purpose: 'Check workflow status and cancel running jobs',
  },
  {
    name: 'Variables',
    scope: 'repo',
    level: 'read-write',
    describedAs: 'action variables',
    purpose: 'Write the LOCALMOST_HEARTBEAT variable that workflows check',
  },
  {
    name: 'Contents',
    scope: 'repo',
    level: 'read',
    describedAs: 'contents',
    purpose: "Fetch the repository's `.localmostrc` sandbox policy",
  },
  {
    name: 'Metadata',
    scope: 'repo',
    level: 'read',
    describedAs: 'metadata',
    purpose: 'Access basic repository information (required by GitHub for all apps)',
  },
  {
    name: 'Self-hosted runners',
    scope: 'org',
    level: 'read-write',
    describedAs: 'self-hosted runners',
    purpose: 'Register and remove self-hosted runners at the organization level',
  },
  {
    name: 'Variables',
    scope: 'org',
    level: 'read-write',
    describedAs: 'action variables',
    purpose: 'Write the LOCALMOST_HEARTBEAT variable at the organization level',
  },
];
