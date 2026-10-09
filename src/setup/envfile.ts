import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';

/**
 * The env file the app loads and the setup wizard edits: ENV_FILE (set in the real
 * environment, e.g. a container volume path) or `.env` in the working directory.
 */
export function envFilePath(): string {
    return path.resolve(process.env.ENV_FILE || '.env');
}

/** Keys the env file put into process.env — everything else in process.env came from the real environment */
const _fromFile = new Set<string>();

/**
 * Load the env file into process.env without overriding the real environment (dotenv's
 * rule), and remember which keys it supplied. Idempotent.
 */
export function loadEnvFile(file: string = envFilePath()): string[] {
    let parsed: Record<string, string> = {};
    try {
        parsed = dotenv.parse(fs.readFileSync(file));
    } catch (err: any) {
        if (err?.code !== 'ENOENT') throw new Error(`Cannot read ${file}: ${err?.message || err}`);
    }
    const applied: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined || _fromFile.has(key)) {
            process.env[key] = value;
            _fromFile.add(key);
            applied.push(key);
        }
    }
    return applied;
}

/** Switch to another env file: forget what the previous one supplied, then load this one */
export function reloadEnvFile(file: string): string[] {
    for (const key of _fromFile) delete process.env[key];
    _fromFile.clear();
    process.env.ENV_FILE = file;
    return loadEnvFile(path.resolve(file));
}

/** Where a setting's current value comes from */
export function valueSource(key: string): 'file' | 'environment' | 'unset' {
    if (_fromFile.has(key)) return 'file';
    return process.env[key] !== undefined ? 'environment' : 'unset';
}

/** Record that `key` is now file-backed (after the wizard wrote it) */
export function markFromFile(key: string, fromFile: boolean): void {
    if (fromFile) _fromFile.add(key);
    else _fromFile.delete(key);
}

/** The values in an env file ({} when it does not exist) */
export function readEnvFile(file: string = envFilePath()): { exists: boolean; content: string; values: Record<string, string> } {
    try {
        const content = fs.readFileSync(file, 'utf8');
        return { exists: true, content, values: dotenv.parse(content) };
    } catch (err: any) {
        if (err?.code === 'ENOENT') return { exists: false, content: '', values: {} };
        throw new Error(`Cannot read ${file}: ${err?.message || err}`);
    }
}

/**
 * Quote a value so dotenv reads back exactly the same string. Candidates are tried from
 * plainest to most robust and each is verified with dotenv's own parser — quoting rules
 * differ subtly (double quotes expand \n, single quotes and backticks keep everything).
 */
export function formatEnvValue(value: string): string {
    const candidates = [value, `'${value}'`, `\`${value}\``, `"${value}"`];
    for (const candidate of candidates) {
        try {
            if (dotenv.parse(`K=${candidate}`).K === value) return candidate;
        } catch {
            // try the next form
        }
    }
    throw new Error('The value contains \', " and ` together — it cannot be written to an env file');
}

const ASSIGNMENT = (key: string) => new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[=:]`);

/** Number of lines an assignment starting at `index` spans (quoted values may continue on later lines) */
function assignmentLength(lines: string[], index: number): number {
    const value = lines[index].replace(/^[^=:]*[=:]\s*/, '');
    const quote = value[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') return 1;
    const closesOnSameLine = (text: string) => {
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\\') { i++; continue; }
            if (text[i] === quote) return true;
        }
        return false;
    };
    if (closesOnSameLine(value.slice(1))) return 1;
    for (let j = index + 1; j < lines.length; j++) {
        if (closesOnSameLine(lines[j])) return j - index + 1;
    }
    return 1; // unterminated: dotenv reads it as a plain value
}

/** Where settings belong in an env file: sections (`# ── Title`) in order, grouped under banners */
export interface EnvLayout {
    sections: { title: string; group: string; keys: string[] }[];
}

const WIDTH = 60;
const RULE = /^#\s*═{3,}\s*$/;
const HEADING = /^#\s*─{2,}\s+(.+?)\s*─*\s*$/;

const headingLine = (title: string) => `# ── ${title} `.padEnd(WIDTH, '─');
const bannerLines = (group: string) => [`# ${'═'.repeat(WIDTH - 2)}`, `#  ${group.toUpperCase()}`, `# ${'═'.repeat(WIDTH - 2)}`];

/** "LDAP / Active Directory (AUTH_PROVIDERS=ldap)" is the heading of section "LDAP / Active Directory" */
function headingMatches(line: string, title: string): boolean {
    const text = HEADING.exec(line)?.[1].toLowerCase();
    const t = title.toLowerCase();
    return !!text && (text === t || text.startsWith(`${t} `));
}

function findHeading(lines: string[], title: string): number {
    return lines.findIndex((l) => headingMatches(l, title));
}

/** Index of the first rule line of the banner for `group`, or -1 */
function findBanner(lines: string[], group: string): number {
    for (let i = 0; i + 2 < lines.length; i++) {
        if (RULE.test(lines[i]) && RULE.test(lines[i + 2]) && lines[i + 1].replace(/^#\s*/, '').trim().toLowerCase() === group.toLowerCase()) return i;
    }
    return -1;
}

/** Insertion point at the end of the block a heading starts: before the next heading or banner, after its last line */
function blockEnd(lines: string[], heading: number): number {
    let end = heading + 1;
    while (end < lines.length && !HEADING.test(lines[end]) && !RULE.test(lines[end])) end++;
    while (end > heading + 1 && lines[end - 1].trim() === '') end--;
    return end;
}

/** Insert lines as a block of their own: one blank line before and after */
function insertBlock(lines: string[], at: number, block: string[]): void {
    const before = at > 0 && lines[at - 1].trim() !== '' ? [''] : [];
    const after = at < lines.length && lines[at].trim() !== '' ? [''] : [];
    lines.splice(at, 0, ...before, ...block, ...after);
}

/**
 * Apply changes to env file content: replace existing assignments in place (keeping
 * comments, order and line endings) and drop removed keys. New keys go under their section
 * heading — created where the layout puts it when missing: after the section before it, in
 * its group (`# ═══ GROUP` banner, used unless the file has headings but no banners).
 *
 * @param changes key → new value, or null to remove the key
 */
export function updateEnvContent(content: string, changes: Record<string, string | null>, layout: EnvLayout = { sections: [] }): string {
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    let lines = content === '' ? [] : content.split(/\r?\n/);
    // A trailing newline yields a final empty element — restored at the end
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const added = new Map<string, string>();
    for (const [key, value] of Object.entries(changes)) {
        const pattern = ASSIGNMENT(key);
        const replacement = value === null ? null : `${key}=${formatEnvValue(value)}`;
        let written = false;
        const next: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (!pattern.test(lines[i])) {
                next.push(lines[i]);
                continue;
            }
            i += assignmentLength(lines, i) - 1;
            // dotenv lets the last assignment win; one assignment is kept, at the first position
            if (!written && replacement !== null) next.push(replacement);
            written = true;
        }
        lines = next;
        if (!written && replacement !== null) added.set(key, replacement);
    }
    if (added.size === 0) return lines.join(eol) + (lines.length > 0 ? eol : '');

    const sections = [...layout.sections];
    const other = { title: 'Other', group: 'Other', keys: [] as string[] };
    const sectionOf = (key: string) => sections.find((s) => s.keys.includes(key)) ?? other;
    if ([...added.keys()].some((k) => sectionOf(k) === other)) sections.push(other);
    const banners = lines.some((l) => RULE.test(l)) || !lines.some((l) => HEADING.test(l));

    // Section by section in layout order, keys in layout order: the file grows in its final order
    for (const [index, section] of sections.entries()) {
        const keys = section === other ? [...added.keys()].filter((k) => sectionOf(k) === other) : section.keys.filter((k) => added.has(k));
        if (keys.length === 0) continue;
        const newLines = keys.map((k) => added.get(k)!);

        const own = findHeading(lines, section.title);
        if (own !== -1) {
            lines.splice(blockEnd(lines, own), 0, ...newLines);
            continue;
        }
        const block = [headingLine(section.title), ...newLines];
        const sameGroup = (s: EnvLayout['sections'][number]) => s.group === section.group;
        // After the nearest earlier section of the group, or before the nearest later one
        const earlier = sections.slice(0, index).filter(sameGroup).reverse().map((s) => findHeading(lines, s.title)).find((i) => i !== -1);
        if (earlier !== undefined) { insertBlock(lines, blockEnd(lines, earlier), block); continue; }
        const later = sections.slice(index + 1).filter(sameGroup).map((s) => findHeading(lines, s.title)).find((i) => i !== -1);
        if (later !== undefined) { insertBlock(lines, later, block); continue; }
        if (banners) {
            const banner = findBanner(lines, section.group);
            if (banner !== -1) { insertBlock(lines, banner + 3, block); continue; }
        }
        // A new group: before the first later group the file has, else at the end
        const groupBlock = banners ? [...bannerLines(section.group), '', ...block] : block;
        const laterGroups = [...new Set(sections.slice(index + 1).map((s) => s.group))].filter((g) => g !== section.group);
        const anchor = laterGroups
            .map((g) => (banners ? findBanner(lines, g) : sections.filter((s) => s.group === g).map((s) => findHeading(lines, s.title)).find((i) => i !== -1) ?? -1))
            .find((i) => i !== -1);
        insertBlock(lines, anchor ?? lines.length, groupBlock);
    }
    return lines.join(eol) + eol;
}

/**
 * Write an env file atomically (temp file + rename) with owner-only permissions; the
 * previous version is kept as `<file>.bak`.
 */
export function writeEnvFile(file: string, content: string): { backup: string | null } {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    let backup: string | null = null;
    if (fs.existsSync(file)) {
        backup = `${file}.bak`;
        fs.copyFileSync(file, backup);
        fs.chmodSync(backup, 0o600);
    }
    const temp = path.join(dir, `${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
        fs.writeSync(fd, content);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    try {
        fs.renameSync(temp, file);
    } catch (err) {
        fs.rmSync(temp, { force: true });
        throw err;
    }
    fs.chmodSync(file, 0o600);
    return { backup };
}
