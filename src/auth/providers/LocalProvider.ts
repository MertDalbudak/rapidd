import bcrypt from 'bcrypt';
import type { AuthProvider, ExternalIdentity, RapiddUser } from '../../types';

/** The slice of Auth the local provider needs (kept narrow to avoid a hard dependency cycle). */
export interface LocalUserSource {
    getUserModel(): any | null;
    readonly options: { identifierFields: string[]; passwordField: string; saltRounds: number };
    buildUserQuery(includePassword: boolean): Record<string, unknown>;
    sanitizeUser(user: Record<string, unknown> | null): RapiddUser | null;
}

/**
 * Password login against the app's own user table (bcrypt hashes).
 * The identifier is matched against every configured identifier field (email, username, ...).
 */
export class LocalProvider implements AuthProvider {
    readonly name: string;
    readonly type = 'local';
    private readonly source: LocalUserSource;
    private dummyHash: Promise<string> | null = null;

    constructor(source: LocalUserSource, name = 'local') {
        this.source = source;
        this.name = name;
    }

    async authenticate(identifier: string, password: string): Promise<ExternalIdentity | null> {
        if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier || !password) return null;

        const User = this.source.getUserModel();
        if (!User) return null;

        const { identifierFields, passwordField } = this.source.options;
        const user: Record<string, unknown> | null = await User.findFirst({
            where: { OR: identifierFields.map((field) => ({ [field]: identifier })) },
            ...this.source.buildUserQuery(true),
        });

        const hash = user?.[passwordField];
        if (typeof hash !== 'string' || !hash) {
            // Unknown user (or an SSO-only account without a password): still pay for one
            // bcrypt comparison so response time does not reveal which identifiers exist
            await bcrypt.compare(password, await this.getDummyHash());
            return null;
        }
        if (!await bcrypt.compare(password, hash)) return null;

        const sanitized = this.source.sanitizeUser(user)!;
        return {
            provider: this.name,
            subject: String(sanitized.id),
            groups: [],
            roles: [],
            claims: {},
            user: sanitized,
        };
    }

    private getDummyHash(): Promise<string> {
        if (!this.dummyHash) {
            this.dummyHash = bcrypt.hash('rapidd-timing-equalizer', this.source.options.saltRounds);
        }
        return this.dummyHash;
    }
}
