import type { AuthConfig } from '../types';

/**
 * Authentication providers and identity mapping.
 *
 * Out of the box Rapidd logs users in against your user table (provider `local`).
 * Single external providers are configured with env vars alone — see .env.example:
 *
 *   AUTH_PROVIDERS=ldap,local        # password providers are tried in this order
 *   AUTH_PROVIDERS=none              # no sign-in: every request is anonymous, src/config/acl.ts decides
 *   LDAP_URL=ldaps://dc1.corp.example.com
 *   OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
 *   SAML_IDP_METADATA_URL=https://login.microsoftonline.com/<tenant-id>/federationmetadata/2007-06/federationmetadata.xml?appid=<app-id>
 *
 * Use this file for several providers of one kind, per-provider linking, or custom logic.
 * Anything set here wins over the env vars.
 *
 * @example
 * // Active Directory login + Entra ID single sign-on + Entra access tokens from your SPA
 * const auth: AuthConfig = {
 *     providers: [
 *         {
 *             type: 'ldap',
 *             url: ['ldaps://dc1.corp.example.com', 'ldaps://dc2.corp.example.com'],
 *             bindDN: 'CN=svc-api,OU=Service Accounts,DC=corp,DC=example,DC=com',
 *             bindPassword: process.env.LDAP_BIND_PASSWORD,
 *             searchBase: 'DC=corp,DC=example,DC=com',
 *             nestedGroups: true,
 *         },
 *         {
 *             type: 'oidc',
 *             name: 'entra',
 *             issuer: `https://login.microsoftonline.com/${process.env.ENTRA_TENANT_ID}/v2.0`,
 *             clientId: process.env.ENTRA_CLIENT_ID,
 *             clientSecret: process.env.ENTRA_CLIENT_SECRET,
 *             audience: 'api://my-api',
 *             subjectClaim: 'oid',
 *         },
 *         { type: 'local' }, // keep local accounts (e.g. service users)
 *         // A second organisation through SAML — /auth/partner/login, metadata at /auth/partner/metadata
 *         { type: 'saml', name: 'partner', idpMetadataUrl: 'https://sso.partner.example/saml/metadata' },
 *     ],
 *     // Link directory/IdP identities to user-table rows by email (the default). Without a
 *     // user table, users are their claims: { id, email, name, groups, roles, provider }
 *     link: { field: 'email', from: 'email' },
 * };
 *
 * @example
 * // Create user-table rows on first SSO login, and lock out deactivated accounts
 * const auth: AuthConfig = {
 *     provision: (identity) => ({ email: identity.email, name: identity.name }),
 *     validateUser: (user) => user.status === 'active',
 *     onLogin: async (user) => { await prisma.user.update({ where: { id: user.id }, data: { last_login: new Date() } }); },
 * };
 */
const auth: AuthConfig = {};

export default auth;
